import * as dgram from 'dgram';
import type { WakeConfig, WakeMethod } from './types';

/**
 * UDP magic packet: classic Wake-on-LAN.
 *
 * It is the default, and it is the one that works everywhere without credentials — on one
 * condition: the packet has to reach the PC's LAN. From a server outside the
 * house you need a host to forward it (a VPN, the router itself), which is why
 * `targetHost` exists instead of always being the broadcast address.
 */

/** 6 bytes of 0xFF followed by the MAC repeated 16 times. */
export function buildMagicPacket(mac: string): Buffer {
    const cleanMac = mac.replace(/[:\-.\s]/g, '');
    if (!/^[0-9a-fA-F]{12}$/.test(cleanMac)) {
        throw new Error(`MAC address non valido: "${mac}"`);
    }

    const macBytes = Buffer.from(cleanMac, 'hex');
    const packet = Buffer.alloc(102);
    packet.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
    return packet;
}

function sendMagicPacket(mac: string, targetHost: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const packet = buildMagicPacket(mac);
        const socket = dgram.createSocket('udp4');

        socket.once('error', (err) => {
            socket.close();
            reject(err);
        });

        socket.bind(() => {
            socket.setBroadcast(true);
            socket.send(packet, 0, packet.length, port, targetHost, (err) => {
                socket.close();
                if (err) reject(err);
                else resolve();
            });
        });
    });
}

export const udpWakeMethod: WakeMethod = {
    id: 'udp',
    label: 'Magic packet (Wake-on-LAN standard)',
    description: 'Funziona con quasi tutti i router, senza credenziali. Il pacchetto deve però poter raggiungere la rete del PC.',
    fields: [
        {
            name: 'targetHost',
            kind: 'text',
            label: 'Broadcast address or host',
            hint: 'Usually the .255 of your LAN, e.g. 192.168.1.255.',
            required: true,
            placeholder: '192.168.1.255',
        },
        {
            name: 'udpPort',
            kind: 'number',
            label: 'UDP port',
            hint: 'Almost always 9.',
            placeholder: '9',
        },
    ],

    async send(config: WakeConfig): Promise<void> {
        const targetHost = String(config.options.targetHost ?? '192.168.1.255');
        const port = Number(config.options.udpPort ?? 9);
        console.log(`[WoL] Invio magic packet UDP → ${targetHost}:${port} (MAC: ${config.macAddress})`);
        await sendMagicPacket(config.macAddress, targetHost, port);
    },
};
