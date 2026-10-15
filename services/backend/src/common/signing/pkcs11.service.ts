import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import * as graphene from 'graphene-pk11';
import { logger } from '../logger';

/**
 * Manages the PKCS#11 module/session lifecycle for HSM-backed signing.
 *
 * Configured via:
 *   PKCS11_MODULE_PATH  - path to the vendor's .so (CloudHSM, Luna, YubiHSM,
 *                         or SoftHSM2 for local/CI testing)
 *   PKCS11_SLOT_LABEL   - token label to open (falls back to the first
 *                         present slot if unset)
 *   PKCS11_PIN          - user PIN to log in with
 *
 * Lazily initialized: a deployment that never creates an HSM-mode wallet
 * never has to talk to a PKCS#11 module at all. If HSM signing IS requested
 * but not configured, this fails closed with a clear error rather than
 * silently falling back to software signing — a wallet's signing mode must
 * never change itself without explicit configuration.
 */
@Injectable()
export class Pkcs11Service implements OnModuleDestroy {
  private module: graphene.Module | null = null;
  private session: graphene.Session | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.PKCS11_MODULE_PATH);
  }

  getSession(): graphene.Session {
    if (this.session) return this.session;

    const modulePath = process.env.PKCS11_MODULE_PATH;
    if (!modulePath) {
      throw new ServiceUnavailableException(
        'HSM signing requested but PKCS11_MODULE_PATH is not set',
      );
    }

    this.module = graphene.Module.load(modulePath, 'OpenPrivy');
    this.module.initialize();

    const slots = this.module.getSlots(true);
    const label = process.env.PKCS11_SLOT_LABEL;
    const slot = label
      ? Array.from({ length: slots.length }, (_, i) => slots.items(i)).find(
          (s) => s.getToken().label.trim() === label,
        )
      : slots.length > 0
        ? slots.items(0)
        : undefined;

    if (!slot) {
      throw new ServiceUnavailableException(
        `No PKCS#11 slot with a present token found${label ? ` (label=${label})` : ''}`,
      );
    }

    this.session = slot.open(
      graphene.SessionFlag.RW_SESSION | graphene.SessionFlag.SERIAL_SESSION,
    );

    const pin = process.env.PKCS11_PIN;
    if (!pin) {
      throw new ServiceUnavailableException('PKCS11_PIN is not set');
    }
    this.session.login(pin);

    logger.info('PKCS#11 session opened for HSM-backed signing');
    return this.session;
  }

  onModuleDestroy() {
    try {
      this.session?.logout();
      this.session?.close();
      this.module?.finalize();
    } catch (error) {
      logger.error(`Error closing PKCS#11 session: ${(error as Error).message}`);
    }
  }
}
