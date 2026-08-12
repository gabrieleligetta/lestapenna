/**
 * Remote wake-up: an interface, not a router.
 *
 * The first table that used Lestapenna has an Iliadbox, and for a while the
 * code believed the world was made that way: that router's login procedure was
 * hardwired inside the service. But every home has its own way of switching a
 * computer on — a broadcast magic packet, one's own router's API, a webhook to
 * Home Assistant, a smart plug.
 *
 * Here is the contract. The implementations live next to it, one per file, and
 * adding one is writing a file and registering it: no extra branch inside
 * a chain of `if`s.
 *
 * **Every method describes its own fields.** That is not pedantry: it is what lets
 * the settings page draw the form knowing nothing about routers, and therefore
 * lets a contributor add their own method without touching the UI or the six
 * translations.
 */

export type WakeFieldKind = 'text' | 'password' | 'number' | 'url';

export interface WakeField {
    /** Key under which the value is stored in the table's settings. */
    name: string;
    kind: WakeFieldKind;
    /** Label in English: the UI shows it as it is. */
    label: string;
    /** What it is for, in one line. */
    hint?: string;
    required?: boolean;
    placeholder?: string;
    /**
     * True when the value is a secret: it goes into the encrypted vault, not into
     * the settings in clear, and it never comes back from a `GET`.
     */
    secret?: boolean;
}

/** Field values, as the table filled them in. */
export interface WakeConfig {
    macAddress: string;
    /** Non-secret fields declared by the method. */
    options: Record<string, string | number | undefined>;
    /** Already decrypted secrets, by field name. */
    secrets: Record<string, string | undefined>;
}

export interface WakeMethod {
    /** Identifier stored in the settings. Do not change it after release. */
    id: string;
    label: string;
    /** When it is worth choosing, in one line. */
    description: string;
    fields: WakeField[];
    /**
     * Sends the signal. Throws when it cannot.
     *
     * It does not wait for the PC to be up: `wakeAndWait` does that, the same for
     * every method — polling `/health` does not depend on how it was switched on.
     */
    send(config: WakeConfig): Promise<void>;
}
