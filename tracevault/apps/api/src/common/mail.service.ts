import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { Db } from '../db/db.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Mail delivery. `outbox` (development/test) stores messages in email_outbox
 * so they can be read from the dev outbox page. `resend` posts to the Resend
 * HTTP API. Message bodies (which may contain one-time links) are never logged.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');

  constructor(
    private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async send(msg: MailMessage): Promise<void> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO email_outbox (to_email, subject, body, provider) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        msg.to,
        msg.subject,
        this.config.mailProvider === 'outbox' ? msg.text : '[sent via provider]',
        this.config.mailProvider,
      ],
    );
    if (this.config.mailProvider === 'outbox') {
      await this.db.query(`UPDATE email_outbox SET status = 'sent' WHERE id = $1`, [row!.id]);
      return;
    }
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.mailFrom,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
        }),
      });
      if (!res.ok) throw new Error(`provider responded ${res.status}`);
      await this.db.query(`UPDATE email_outbox SET status = 'sent' WHERE id = $1`, [row!.id]);
    } catch (err) {
      // Surface the failure in the outbox table and logs instead of discarding it.
      const message = (err as Error).message;
      await this.db.query(`UPDATE email_outbox SET status = 'failed', error = $2 WHERE id = $1`, [
        row!.id,
        message,
      ]);
      this.logger.error(`delivery failed (outbox id ${row!.id}): ${message}`);
    }
  }
}
