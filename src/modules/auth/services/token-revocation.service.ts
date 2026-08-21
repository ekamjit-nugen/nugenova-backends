import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { RevokedTokenEntity } from '../entities/revoked-token.entity';
import { newObjectId } from '../../../bootstrap/database/object-id';

/**
 * jti deny-list. `revoke` records an access token's jti until its natural
 * expiry; `isRevoked` is checked by the JWT guard on every request. Kept a
 * thin repository wrapper so the guard/service never touch TypeORM directly.
 */
@Injectable()
export class TokenRevocationService {
  private readonly logger = new Logger(TokenRevocationService.name);

  constructor(
    @InjectRepository(RevokedTokenEntity)
    private readonly repo: Repository<RevokedTokenEntity>,
  ) {}

  async revoke(jti: string, expiresAt: Date, userId?: string): Promise<void> {
    if (!jti) return;
    try {
      await this.repo
        .createQueryBuilder()
        .insert()
        // QueryBuilder.insert() bypasses the @BeforeInsert id hook on
        // PgBaseEntity, so the ObjectId primary key must be supplied here —
        // otherwise the NOT NULL id constraint fails and the revocation is a
        // silent no-op (logged-out tokens would keep authenticating).
        .values({ id: newObjectId(), jti, expiresAt, userId: userId ?? null })
        .orIgnore()
        .execute();
    } catch (err: any) {
      this.logger.warn(`Failed to revoke jti ${jti}: ${err?.message || err}`);
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    if (!jti) return false;
    const count = await this.repo.count({ where: { jti } });
    return count > 0;
  }

  /** Drop deny-list rows past their expiry (the token is dead on expiry anyway). */
  async sweepExpired(now = new Date()): Promise<number> {
    const res = await this.repo.delete({ expiresAt: LessThan(now) });
    return res.affected ?? 0;
  }
}
