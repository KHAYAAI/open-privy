import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, In, LessThanOrEqual, MoreThan } from 'typeorm';
import * as crypto from 'crypto';
import { Guardian } from './entities/guardian.entity';
import { OPEN_STATUSES, RecoveryRequest, RecoveryStatus } from './entities/recovery-request.entity';
import { RecoveryApproval } from './entities/recovery-approval.entity';
import { User } from '../auth/entities/user.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { AuditLog } from '../../common/entities/audit-log.entity';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { assertKeyMatchesAddress } from '../../common/encryption/key-rotation';
import { NOTIFIER, Notifier } from '../../common/notify/notifier';
import { logger } from '../../common/logger';

export const MIN_GUARDIANS = 3;
export const MAX_GUARDIANS = 5;
const HOUR = 3_600_000;
const INVITE_TTL_MS = 7 * 24 * HOUR;
const APPROVAL_WINDOW_MS = 7 * 24 * HOUR;
const COOLDOWN_MS = 24 * HOUR;

/** Majority of active guardians: 2 of 3, 3 of 4, 3 of 5. */
export function thresholdFor(activeGuardians: number): number {
  return Math.floor(activeGuardians / 2) + 1;
}

export function newToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function validTokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/**
 * Social recovery for custodial wallets: when enough of an owner's guardians
 * vouch and the old account does not object within the time lock, the old
 * account's wallets move to the requester's new account.
 * Design and threat model: docs/SOCIAL_RECOVERY_DESIGN.md.
 */
@Injectable()
export class RecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly timeLockMs = Number(process.env.RECOVERY_TIME_LOCK_HOURS || 48) * HOUR;
  private readonly appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
  ) {}

  onModuleInit() {
    const interval = Number(process.env.RECOVERY_SWEEP_INTERVAL_MS || 60_000);
    if (interval > 0 && process.env.ENABLE_SOCIAL_RECOVERY === 'true') {
      this.sweepTimer = setInterval(() => this.sweep().catch((e) => logger.error(`Recovery sweep failed: ${e.message}`)), interval);
      this.sweepTimer.unref();
    }
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private get guardians() {
    return this.dataSource.getRepository(Guardian);
  }
  private get requests() {
    return this.dataSource.getRepository(RecoveryRequest);
  }
  private get approvals() {
    return this.dataSource.getRepository(RecoveryApproval);
  }
  private get users() {
    return this.dataSource.getRepository(User);
  }

  // ---------------------------------------------------------------- setup

  async listGuardians(ownerUserId: string) {
    const rows = await this.guardians.find({
      where: { ownerUserId, status: In(['pending', 'active']) },
      order: { createdAt: 'ASC' },
    });
    const active = rows.filter((g) => g.status === 'active').length;
    return {
      guardians: rows.map((g) => ({ id: g.id, name: g.name, email: g.email, status: g.status, confirmedAt: g.confirmedAt })),
      activeGuardians: active,
      threshold: active >= MIN_GUARDIANS ? thresholdFor(active) : null,
      recoveryReady: active >= MIN_GUARDIANS,
      minimumGuardians: MIN_GUARDIANS,
    };
  }

  async addGuardian(ownerUserId: string, name: string, rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    const owner = await this.users.findOneByOrFail({ id: ownerUserId });
    if (email === owner.email.toLowerCase()) {
      throw new BadRequestException('You cannot be your own guardian.');
    }
    const current = await this.guardians.find({ where: { ownerUserId, status: In(['pending', 'active']) } });
    if (current.some((g) => g.email === email)) throw new BadRequestException('That person is already a guardian.');
    if (current.length >= MAX_GUARDIANS) throw new BadRequestException(`You can have at most ${MAX_GUARDIANS} guardians.`);

    const { token, hash } = newToken();
    const guardian = await this.guardians.save(
      this.guardians.create({
        ownerUserId,
        name: name.trim(),
        email,
        status: 'pending',
        inviteTokenHash: hash,
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
      }),
    );
    await this.notifier.send({
      to: email,
      subject: `${owner.username || owner.email} asked you to be a recovery guardian on OpenPrivy`,
      text:
        `${owner.username || owner.email} (${owner.email}) added you as a guardian for their OpenPrivy wallet.\n\n` +
        `If they ever lose access to their account, you may be asked to confirm a recovery request. ` +
        `Only approve a request after speaking to them directly.\n\n` +
        `To accept, open this link within 7 days:\n${this.appUrl}/recovery/guardian?token=${token}\n\n` +
        `If you don't know this person, ignore this email.`,
    });
    await this.audit(ownerUserId, 'RECOVERY_GUARDIAN_INVITED', { guardianId: guardian.id });
    return { id: guardian.id, name: guardian.name, email: guardian.email, status: guardian.status };
  }

  async removeGuardian(ownerUserId: string, guardianId: string) {
    const guardian = await this.guardians.findOne({ where: { id: guardianId, ownerUserId, status: In(['pending', 'active']) } });
    if (!guardian) throw new NotFoundException('Guardian not found.');
    guardian.status = 'removed';
    guardian.inviteTokenHash = null;
    await this.guardians.save(guardian);
    await this.audit(ownerUserId, 'RECOVERY_GUARDIAN_REMOVED', { guardianId });
  }

  /** What the guardian sees before accepting. No side effects (email scanners open links). */
  async describeInvite(token: unknown) {
    const guardian = await this.findInvite(token);
    const owner = await this.users.findOneByOrFail({ id: guardian.ownerUserId });
    return { ownerName: owner.username || null, ownerEmail: owner.email, guardianName: guardian.name };
  }

  async confirmInvite(token: unknown) {
    const guardian = await this.findInvite(token);
    guardian.status = 'active';
    guardian.confirmedAt = new Date();
    guardian.inviteTokenHash = null;
    await this.guardians.save(guardian);
    await this.audit(guardian.ownerUserId, 'RECOVERY_GUARDIAN_CONFIRMED', { guardianId: guardian.id });
    return { confirmed: true };
  }

  private async findInvite(token: unknown): Promise<Guardian> {
    const invalid = new NotFoundException('This invitation link is invalid or has expired.');
    if (!validTokenShape(token)) throw invalid;
    const guardian = await this.guardians.findOne({ where: { inviteTokenHash: hashToken(token), status: 'pending' } });
    if (!guardian || !guardian.inviteExpiresAt || guardian.inviteExpiresAt < new Date()) throw invalid;
    return guardian;
  }

  // ---------------------------------------------------------------- request

  /**
   * Start recovering the account registered to oldEmail onto the signed-in
   * (new) account. Responds identically whether or not that account exists
   * or has recovery set up, so it cannot be used to discover accounts.
   */
  async startRequest(newUserId: string, rawOldEmail: string): Promise<{ message: string }> {
    const generic = {
      message:
        'If that account has recovery set up, its guardians have been asked to confirm. ' +
        'You can follow progress here.',
    };
    const oldEmail = rawOldEmail.trim().toLowerCase();
    const newUser = await this.users.findOneByOrFail({ id: newUserId });

    if (await this.requests.exist({ where: { newUserId, status: In(OPEN_STATUSES) } })) {
      throw new BadRequestException('You already have a recovery in progress.');
    }
    if (await this.dataSource.getRepository(Wallet).exist({ where: { userId: newUserId } })) {
      throw new BadRequestException('Recover into a new account that has no wallets yet.');
    }

    const oldUser = await this.users
      .createQueryBuilder('u')
      .where('LOWER(u.email) = :email', { email: oldEmail })
      .getOne();
    if (!oldUser || oldUser.id === newUserId || oldUser.lockedAt) {
      await this.audit(newUserId, 'RECOVERY_REQUEST_IGNORED', { reason: 'no eligible account' });
      return generic;
    }

    const active = await this.guardians.find({ where: { ownerUserId: oldUser.id, status: 'active' } });
    const blocked =
      active.length < MIN_GUARDIANS ||
      (await this.requests.exist({ where: { oldUserId: oldUser.id, status: In(OPEN_STATUSES) } })) ||
      (await this.requests.exist({
        where: { oldUserId: oldUser.id, status: In(['cancelled', 'declined']), closedAt: MoreThan(new Date(Date.now() - COOLDOWN_MS)) },
      }));
    if (blocked) {
      await this.audit(newUserId, 'RECOVERY_REQUEST_IGNORED', { oldUserId: oldUser.id, reason: 'not eligible now' });
      return generic;
    }

    // A guardian cannot vouch for a request made from their own address.
    const voters = active.filter((g) => g.email !== newUser.email.toLowerCase());
    const threshold = thresholdFor(active.length);
    if (voters.length < threshold) {
      await this.audit(newUserId, 'RECOVERY_REQUEST_IGNORED', { oldUserId: oldUser.id, reason: 'requester is a guardian' });
      return generic;
    }

    const cancel = newToken();
    const tokens: Array<{ guardian: Guardian; token: string }> = [];
    const request = await this.dataSource.transaction(async (m) => {
      const req = await m.save(
        m.create(RecoveryRequest, {
          oldUserId: oldUser.id,
          newUserId,
          status: 'awaiting_approvals',
          threshold,
          cancelTokenHash: cancel.hash,
          approvalsExpireAt: new Date(Date.now() + APPROVAL_WINDOW_MS),
        }),
      );
      for (const guardian of voters) {
        const t = newToken();
        await m.save(m.create(RecoveryApproval, { requestId: req.id, guardianId: guardian.id, tokenHash: t.hash }));
        tokens.push({ guardian, token: t.token });
      }
      return req;
    });

    const ownerLabel = oldUser.username ? `${oldUser.username} (${oldUser.email})` : oldUser.email;
    for (const { guardian, token } of tokens) {
      await this.notifier.send({
        to: guardian.email,
        subject: `Recovery request for ${ownerLabel}'s OpenPrivy wallet`,
        text:
          `Hi ${guardian.name},\n\nSomeone signed in as ${newUser.email} is asking to recover ${ownerLabel}'s wallet ` +
          `onto that account. You are one of their guardians.\n\n` +
          `Before you approve, contact ${oldUser.username || 'them'} directly (phone or in person, not by replying to a ` +
          `message from the new address) and confirm they really lost access.\n\n` +
          `Review and approve or decline:\n${this.appUrl}/recovery/approve?token=${token}\n\n` +
          `If anything seems wrong, decline. A single decline stops the request.`,
      });
    }
    await this.notifier.send({
      to: oldUser.email,
      subject: 'Someone is trying to recover your OpenPrivy wallet',
      text:
        `A recovery request for your OpenPrivy wallet was started from the account ${newUser.email}.\n\n` +
        `If this wasn't you, stop it now:\n${this.appUrl}/recovery/cancel?token=${cancel.token}\n\n` +
        `Signing in to your account also stops it. If it was you, no action is needed: once your guardians approve, ` +
        `your wallets move to the new account after a ${this.timeLockMs / HOUR}-hour waiting period.`,
    });
    await this.audit(newUserId, 'RECOVERY_REQUESTED', { requestId: request.id, oldUserId: oldUser.id, threshold });
    await this.audit(oldUser.id, 'RECOVERY_REQUESTED_AGAINST', { requestId: request.id, newUserId });
    return generic;
  }

  /** The requester's view of their own open or latest request. */
  async currentRequest(newUserId: string) {
    let req = await this.requests.findOne({ where: { newUserId }, order: { createdAt: 'DESC' } });
    if (!req) return { status: 'none' as const };
    if (req.status === 'time_locked' && req.unlocksAt && req.unlocksAt <= new Date()) {
      await this.complete(req.id);
      req = await this.requests.findOneByOrFail({ id: req.id });
    }
    const approved = await this.approvals.count({ where: { requestId: req.id, decision: 'approved' } });
    return {
      status: req.status,
      approvals: approved,
      threshold: req.threshold,
      approvalsExpireAt: req.approvalsExpireAt,
      unlocksAt: req.unlocksAt,
      closedReason: req.closedReason,
    };
  }

  // ---------------------------------------------------------------- guardians vote

  /** What the guardian sees before deciding. No side effects. */
  async describeApproval(token: unknown) {
    const { request } = await this.findOpenApproval(token);
    const [oldUser, newUser] = await Promise.all([
      this.users.findOneByOrFail({ id: request.oldUserId }),
      this.users.findOneByOrFail({ id: request.newUserId }),
    ]);
    return {
      ownerName: oldUser.username || null,
      ownerEmail: oldUser.email,
      requestedBy: newUser.email,
      requestedAt: request.createdAt,
      timeLockHours: this.timeLockMs / HOUR,
    };
  }

  async decide(token: unknown, decision: unknown) {
    if (decision !== 'approve' && decision !== 'decline') {
      throw new BadRequestException('decision must be "approve" or "decline"');
    }
    return this.dataSource.transaction(async (m) => {
      const { approval, request } = await this.findOpenApproval(token, m);
      approval.decision = decision === 'approve' ? 'approved' : 'declined';
      approval.decidedAt = new Date();
      approval.tokenHash = null;
      await m.save(approval);

      if (decision === 'decline') {
        await this.close(m, request, 'declined', 'A guardian declined');
        await this.audit(request.oldUserId, 'RECOVERY_DECLINED', { requestId: request.id, guardianId: approval.guardianId }, m);
        return { status: 'declined' };
      }

      const approved = await m.count(RecoveryApproval, { where: { requestId: request.id, decision: 'approved' } });
      await this.audit(request.oldUserId, 'RECOVERY_APPROVED_BY_GUARDIAN', { requestId: request.id, guardianId: approval.guardianId, approved }, m);
      if (approved >= request.threshold) {
        request.status = 'time_locked';
        request.unlocksAt = new Date(Date.now() + this.timeLockMs);
        await m.save(request);
        const oldUser = await m.findOneByOrFail(User, { id: request.oldUserId });
        await this.notifier.send({
          to: oldUser.email,
          subject: `Your OpenPrivy wallet will move to another account in ${this.timeLockMs / HOUR} hours`,
          text:
            `Your guardians approved a recovery request. Your wallets will move to the requesting account at ` +
            `${request.unlocksAt.toISOString()} unless you stop it.\n\nIf this wasn't you, use the cancel link from the ` +
            `earlier email or sign in to your account now.`,
        });
        return { status: 'time_locked', unlocksAt: request.unlocksAt };
      }
      return { status: 'awaiting_approvals', approvals: approved, threshold: request.threshold };
    });
  }

  private async findOpenApproval(token: unknown, m: EntityManager = this.dataSource.manager) {
    const invalid = new NotFoundException('This link is invalid, already used, or the request is closed.');
    if (!validTokenShape(token)) throw invalid;
    const approval = await m.findOne(RecoveryApproval, {
      where: { tokenHash: hashToken(token), decision: 'pending' },
      lock: m.queryRunner ? { mode: 'pessimistic_write' } : undefined,
    });
    if (!approval) throw invalid;
    const request = await m.findOne(RecoveryRequest, {
      where: { id: approval.requestId },
      lock: m.queryRunner ? { mode: 'pessimistic_write' } : undefined,
    });
    if (!request || request.status !== 'awaiting_approvals') throw invalid;
    if (request.approvalsExpireAt < new Date()) {
      await this.close(m, request, 'expired', 'Guardians did not respond in time');
      throw invalid;
    }
    return { approval, request };
  }

  // ---------------------------------------------------------------- cancel

  /** "This wasn't me" link from the email sent to the old account. */
  async cancelByToken(token: unknown) {
    const invalid = new NotFoundException('This link is invalid or the request is already closed.');
    if (!validTokenShape(token)) throw invalid;
    const request = await this.requests.findOne({
      where: { cancelTokenHash: hashToken(token), status: In(['awaiting_approvals', 'time_locked']) },
    });
    if (!request) throw invalid;
    await this.dataSource.transaction((m) => this.close(m, request, 'cancelled', 'Cancelled by the account owner'));
    await this.audit(request.oldUserId, 'RECOVERY_CANCELLED', { requestId: request.id, via: 'email link' });
    return { cancelled: true };
  }

  /** Called on every successful sign-in: someone with access is not locked out, so open requests against them end. */
  async cancelForSignIn(oldUserId: string) {
    const open = await this.requests.find({ where: { oldUserId, status: In(['awaiting_approvals', 'time_locked']) } });
    for (const request of open) {
      await this.dataSource.transaction((m) => this.close(m, request, 'cancelled', 'The account owner signed in'));
      await this.audit(oldUserId, 'RECOVERY_CANCELLED', { requestId: request.id, via: 'sign-in' });
    }
  }

  private async close(m: EntityManager, request: RecoveryRequest, status: RecoveryStatus, reason: string) {
    request.status = status;
    request.closedAt = new Date();
    request.closedReason = reason;
    await m.save(request);
    await m.update(RecoveryApproval, { requestId: request.id }, { tokenHash: null });
  }

  // ---------------------------------------------------------------- completion

  /** Completes every request whose time lock has passed; expires stale ones. Safe to run on every replica. */
  async sweep(): Promise<number> {
    const stale = await this.requests.find({ where: { status: 'awaiting_approvals', approvalsExpireAt: LessThanOrEqual(new Date()) } });
    for (const r of stale) await this.dataSource.transaction((m) => this.close(m, r, 'expired', 'Guardians did not respond in time'));
    const due = await this.requests.find({ where: { status: 'time_locked', unlocksAt: LessThanOrEqual(new Date()) } });
    let done = 0;
    for (const r of due) if (await this.complete(r.id)) done++;
    return done;
  }

  /**
   * Moves every wallet of the old account to the new one, in one transaction.
   * Software keys are re-encrypted under the new account's per-user key and
   * verified against their address before saving; HSM keys never move.
   * The atomic status claim means only one replica can complete a request.
   */
  async complete(requestId: string): Promise<boolean> {
    const claim = await this.requests
      .createQueryBuilder()
      .update(RecoveryRequest)
      .set({ status: 'completing' })
      .where('id = :id AND status = :s AND "unlocksAt" <= now()', { id: requestId, s: 'time_locked' })
      .execute();
    if (claim.affected !== 1) return false;

    try {
      const moved = await this.dataSource.transaction(async (m) => {
        const request = await m.findOneByOrFail(RecoveryRequest, { id: requestId });
        const wallets = await m.find(Wallet, { where: { userId: request.oldUserId } });
        for (const w of wallets) {
          if (w.signingMode === 'software' && w.encryptedPrivateKey) {
            const plaintext = await this.encryption.decrypt(w.encryptedPrivateKey, request.oldUserId);
            assertKeyMatchesAddress(w.chain, plaintext, w.address);
            const ciphertext = await this.encryption.encrypt(plaintext, request.newUserId);
            if ((await this.encryption.decryptWithCurrentKeyOnly(ciphertext, request.newUserId)) !== plaintext) {
              throw new Error(`re-encrypted key for wallet ${w.id} does not round-trip`);
            }
            w.encryptedPrivateKey = ciphertext;
            w.encryptionKeyId = this.encryption.currentKeyId;
          }
          w.userId = request.newUserId;
          await m.save(w);
        }
        const now = new Date();
        await m.update(User, { id: request.oldUserId }, { lockedAt: now, sessionsValidAfter: now });
        await m.update(Guardian, { ownerUserId: request.oldUserId, status: In(['pending', 'active']) }, { status: 'removed', inviteTokenHash: null });
        request.status = 'completed';
        request.closedAt = now;
        request.closedReason = `Recovered ${wallets.length} wallet(s)`;
        await m.save(request);
        await this.audit(request.newUserId, 'RECOVERY_COMPLETED', { requestId, oldUserId: request.oldUserId, wallets: wallets.map((w) => w.id) }, m);
        await this.audit(request.oldUserId, 'ACCOUNT_LOCKED_AFTER_RECOVERY', { requestId, newUserId: request.newUserId }, m);
        return wallets.length;
      });
      logger.info(`Recovery ${requestId} completed: ${moved} wallet(s) moved`);
      return true;
    } catch (e) {
      // Nothing was written (transaction rolled back): hand it back for another attempt and alert.
      await this.requests.update({ id: requestId, status: 'completing' }, { status: 'time_locked' });
      logger.error(`Recovery ${requestId} could not complete: ${e.message}`);
      return false;
    }
  }

  private async audit(userId: string, eventType: string, metadata: Record<string, any>, m: EntityManager = this.dataSource.manager) {
    await m.save(m.create(AuditLog, { userId, eventType, metadata }));
  }
}
