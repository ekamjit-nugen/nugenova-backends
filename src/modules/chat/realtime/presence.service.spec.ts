import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PresenceService } from './presence.service';
import { LeaveRequestEntity } from '../../leave/entities/leave-request.entity';

/**
 * Unit specs for PresenceService — the in-memory presence model behind the chat
 * gateway. No sockets and no DB: the LeaveRequest repo is a mocked `count`, so
 * these pin the pure state machine (online/away/offline transitions), the idle
 * sweep, and the on-holiday resolution from approved leave.
 */
describe('PresenceService', () => {
  let service: PresenceService;
  let leaveCount: jest.Mock;

  beforeEach(async () => {
    leaveCount = jest.fn().mockResolvedValue(0);
    const moduleRef = await Test.createTestingModule({
      providers: [
        PresenceService,
        {
          provide: getRepositoryToken(LeaveRequestEntity),
          useValue: { count: leaveCount },
        },
      ],
    }).compile();
    service = moduleRef.get(PresenceService);
  });

  afterEach(() => {
    // Stop the sweep interval so Jest doesn't hold an open handle.
    service.onModuleDestroy();
  });

  describe('online / away / offline transitions', () => {
    it('a connected user is online', async () => {
      service.onConnect('alice', 'orgA');
      expect(service.isOnline('alice')).toBe(true);
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe('online');
    });

    it('setAway makes a still-connected user away (not online)', async () => {
      service.onConnect('alice', 'orgA');
      service.setAway('alice');
      expect(service.isOnline('alice')).toBe(false);
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe('away');
    });

    it('a heartbeat clears away and returns the user to online', async () => {
      service.onConnect('alice', 'orgA');
      service.setAway('alice');
      service.heartbeat('alice', 'orgA');
      expect(service.isOnline('alice')).toBe(true);
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe('online');
    });

    it('stays online while at least one socket remains', async () => {
      service.onConnect('alice', 'orgA'); // 2 tabs
      service.onConnect('alice', 'orgA');
      service.onDisconnect('alice');
      expect(service.isOnline('alice')).toBe(true);
      service.onDisconnect('alice');
      expect(service.isOnline('alice')).toBe(false);
    });

    it('a fully disconnected user with no leave is offline', async () => {
      service.onConnect('alice', 'orgA');
      service.onDisconnect('alice');
      expect(service.isOnline('alice')).toBe(false);
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe('offline');
    });

    it('an unknown user is offline and not online', async () => {
      expect(service.isOnline('ghost')).toBe(false);
      await expect(service.resolveStatus('ghost', 'orgA')).resolves.toBe('offline');
    });
  });

  describe('resolveStatus + leave', () => {
    it('returns on_holiday when the disconnected user is on approved leave today', async () => {
      leaveCount.mockResolvedValue(1);
      // No sockets → falls through to the leave check.
      await expect(service.resolveStatus('bob', 'orgA')).resolves.toBe('on_holiday');
      expect(leaveCount).toHaveBeenCalledTimes(1);
    });

    it('returns offline when the disconnected user has no approved leave today', async () => {
      leaveCount.mockResolvedValue(0);
      await expect(service.resolveStatus('bob', 'orgA')).resolves.toBe('offline');
    });

    it('a connected user never triggers a leave lookup', async () => {
      service.onConnect('bob', 'orgA');
      await service.resolveStatus('bob', 'orgA');
      expect(leaveCount).not.toHaveBeenCalled();
    });

    it('is fail-safe: a leave-repo error resolves to offline, not a throw', async () => {
      leaveCount.mockRejectedValue(new Error('db down'));
      await expect(service.resolveStatus('bob', 'orgA')).resolves.toBe('offline');
    });
  });

  describe('snapshotForOrg', () => {
    it('resolves a status per unique member', async () => {
      service.onConnect('alice', 'orgA');
      service.onConnect('carol', 'orgA');
      service.setAway('carol');
      leaveCount.mockResolvedValue(0); // dave: offline
      const snap = await service.snapshotForOrg('orgA', ['alice', 'carol', 'dave', 'alice']);
      expect(snap).toEqual([
        { userId: 'alice', status: 'online' },
        { userId: 'carol', status: 'away' },
        { userId: 'dave', status: 'offline' },
      ]);
    });
  });

  describe('manual status override', () => {
    it('a manual busy overrides auto-online while connected', async () => {
      service.onConnect('alice', 'orgA');
      service.setManual('alice', 'busy', 'orgA');
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe('busy');
    });

    it('a manual busy is NOT flipped to away by the idle sweep', async () => {
      const changes: any[] = [];
      service.registerChangeListener((c) => changes.push(c));
      service.onConnect('alice', 'orgA');
      service.setManual('alice', 'busy', 'orgA');

      service.sweepAway(Date.now() + PresenceService.AWAY_AFTER_MS + 1000);

      expect(changes).toHaveLength(0); // sweep left the manual override alone
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe('busy');
    });

    it('a manual offline shows offline while still connected', async () => {
      service.onConnect('alice', 'orgA');
      service.setManual('alice', 'offline', 'orgA');
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe(
        'offline',
      );
      // No leave lookup — the user is connected, override wins.
      expect(leaveCount).not.toHaveBeenCalled();
    });

    it('a manual away overrides online while connected', async () => {
      service.onConnect('alice', 'orgA');
      service.setManual('alice', 'away', 'orgA');
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe('away');
    });

    it("setManual('active') clears a prior override and resumes auto-online", async () => {
      service.onConnect('alice', 'orgA');
      service.setManual('alice', 'busy', 'orgA');
      service.setManual('alice', 'active', 'orgA');
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe(
        'online',
      );
    });

    it('precedence: manual > on_holiday > auto when connected', async () => {
      // On approved leave today, but connected AND manually busy → busy wins.
      leaveCount.mockResolvedValue(1);
      service.onConnect('alice', 'orgA');
      service.setManual('alice', 'busy', 'orgA');
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe('busy');
      // Manual wins without ever consulting leave while connected.
      expect(leaveCount).not.toHaveBeenCalled();
    });

    it('a manual-offline user resolves normally (on_holiday/offline) once disconnected', async () => {
      service.onConnect('alice', 'orgA');
      service.setManual('alice', 'offline', 'orgA');
      service.onDisconnect('alice'); // full disconnect clears the override
      leaveCount.mockResolvedValue(1); // on approved leave today
      await expect(service.resolveStatus('alice', 'orgA')).resolves.toBe(
        'on_holiday',
      );
    });

    it('an idle-away user (no manual) IS still swept', () => {
      // Guards against the sweep guard being too broad.
      const changes: any[] = [];
      service.registerChangeListener((c) => changes.push(c));
      service.onConnect('alice', 'orgA');

      service.sweepAway(Date.now() + PresenceService.AWAY_AFTER_MS + 1000);
      expect(changes).toEqual([
        { userId: 'alice', orgId: 'orgA', status: 'away' },
      ]);
    });
  });

  describe('idle away sweep', () => {
    it('flips an idle connected user to away and notifies the listener', () => {
      const changes: any[] = [];
      service.registerChangeListener((c) => changes.push(c));
      service.onConnect('alice', 'orgA');

      // Sweep with a clock past the away threshold.
      const future = Date.now() + PresenceService.AWAY_AFTER_MS + 1000;
      service.sweepAway(future);

      expect(service.isOnline('alice')).toBe(false);
      expect(changes).toEqual([{ userId: 'alice', orgId: 'orgA', status: 'away' }]);
    });

    it('does not sweep a user who is still within the idle window', () => {
      const changes: any[] = [];
      service.registerChangeListener((c) => changes.push(c));
      service.onConnect('alice', 'orgA');

      service.sweepAway(Date.now() + 1000); // well under the threshold
      expect(service.isOnline('alice')).toBe(true);
      expect(changes).toHaveLength(0);
    });

    it('does not re-sweep an already-away user', () => {
      const changes: any[] = [];
      service.registerChangeListener((c) => changes.push(c));
      service.onConnect('alice', 'orgA');
      service.setAway('alice');

      service.sweepAway(Date.now() + PresenceService.AWAY_AFTER_MS + 1000);
      expect(changes).toHaveLength(0); // already away → no duplicate transition
    });

    it('does not sweep a disconnected user', () => {
      const changes: any[] = [];
      service.registerChangeListener((c) => changes.push(c));
      service.onConnect('alice', 'orgA');
      service.onDisconnect('alice');

      service.sweepAway(Date.now() + PresenceService.AWAY_AFTER_MS + 1000);
      expect(changes).toHaveLength(0);
    });
  });
});
