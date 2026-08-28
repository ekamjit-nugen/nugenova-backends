import { describeDevice } from './auth.service';

describe('describeDevice', () => {
  it('labels Chrome on macOS', () => {
    expect(
      describeDevice(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
  });

  it('labels Safari on iOS', () => {
    expect(
      describeDevice(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
  });

  it('labels Firefox on Windows', () => {
    expect(
      describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'),
    ).toBe('Firefox on Windows');
  });

  it('labels Edge and Chrome on Android', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120')).toBe('Edge on Windows');
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36')).toBe('Chrome on Android');
  });

  it('falls back gracefully for missing or unknown agents', () => {
    expect(describeDevice(undefined)).toBe('Unknown device');
    expect(describeDevice(null)).toBe('Unknown device');
    expect(describeDevice('')).toBe('Unknown device');
    expect(describeDevice('some-random-cli/1.0')).toBe('Browser');
  });
});
