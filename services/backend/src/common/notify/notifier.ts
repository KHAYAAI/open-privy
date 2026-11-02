import * as fs from 'fs';
import { logger } from '../logger';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends transactional email. Implementations must never log message bodies (they carry one-time links). */
export interface Notifier {
  send(message: EmailMessage): Promise<void>;
}

export const NOTIFIER = 'NOTIFIER';

/** Production: AWS SES v2, using the pod's IAM role (same as Secrets Manager). */
export class SesNotifier implements Notifier {
  private client: any;

  constructor(
    private readonly from: string,
    private readonly region = process.env.AWS_REGION || 'us-east-1',
  ) {}

  async send({ to, subject, text }: EmailMessage): Promise<void> {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    this.client ??= new SESv2Client({ region: this.region });
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
      }),
    );
    logger.info(`Email sent: "${subject}"`);
  }
}

/**
 * Tests and local drills only: appends messages as JSON lines to a file (or
 * keeps them in memory). Refuses production so one-time links are never
 * written to disk on a real deployment.
 */
export class OutboxNotifier implements Notifier {
  readonly messages: EmailMessage[] = [];

  constructor(private readonly file?: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('The email outbox is for tests only and cannot run with NODE_ENV=production');
    }
  }

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(message) + '\n');
  }
}

/** NOTIFIER_PROVIDER=ses (needs MAIL_FROM) or outbox (non-production; NOTIFIER_OUTBOX_FILE optional). */
export function createNotifier(): Notifier {
  const provider = process.env.NOTIFIER_PROVIDER || (process.env.NODE_ENV === 'production' ? 'ses' : 'outbox');
  if (provider === 'ses') {
    const from = process.env.MAIL_FROM;
    if (!from) throw new Error('MAIL_FROM must be set to send email through SES');
    return new SesNotifier(from);
  }
  if (provider === 'outbox') return new OutboxNotifier(process.env.NOTIFIER_OUTBOX_FILE);
  throw new Error(`Unknown NOTIFIER_PROVIDER "${provider}" (expected ses or outbox)`);
}
