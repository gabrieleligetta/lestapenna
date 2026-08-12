/**
 * Generates a master key for the secret vault.
 *
 * It only prints it: the key is not saved anywhere, because the right place
 * for it is the process environment, not a file inside the project.
 *
 * ⚠️ Do not keep it in the same bucket as the Litestream replica, nor under
 * `data/`: it would end up in the very backup of the data it protects. If you
 * lose it, every stored credential has to be re-entered by hand by each table.
 */

import * as crypto from 'crypto';

console.log(crypto.randomBytes(32).toString('base64'));
