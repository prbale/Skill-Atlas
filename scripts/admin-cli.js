#!/usr/bin/env node
'use strict';
/**
 * Break-glass administration from the server shell (never exposed over HTTP).
 *   docker compose exec app node scripts/admin-cli.js <command> [username]
 *
 * Commands:
 *   list-users                 Show all accounts
 *   reset-password <username>  Set a random temporary password (must be changed at next sign-in)
 *   reset-mfa <username>       Turn off two-step verification and sign the user out
 *   unlock <username>          Clear failed-sign-in lockout
 *   promote <username>         Make the account an administrator
 *   backup                     Write a consistent database backup to /data/backups
 */
const crypto = require('node:crypto');
const db = require('../database');

async function main() {
  const [cmd, name] = process.argv.slice(2);
  const need = () => { const u = name && db.findUserRow(name); if (!u) { console.error(`No account named "${name || ''}".`); process.exit(2); } return u; };
  switch (cmd) {
    case 'list-users':
      console.table(db.listUsers().map((u) => ({ id: u.id, username: u.username, role: u.role, disabled: u.disabled, mfa: u.mfaEnabled, mustChange: u.mustChangePassword })));
      break;
    case 'reset-password': {
      const u = need();
      const temp = crypto.randomBytes(12).toString('base64url');
      await db.resetUserPassword(u.id, temp);
      db.audit('cli', 'cli.password_reset', u.username, 'local');
      console.log(`Temporary password for ${u.username}: ${temp}\nThey must change it at next sign-in. Share it privately.`);
      break;
    }
    case 'reset-mfa': { const u = need(); db.resetMfa(u.id); db.audit('cli', 'cli.mfa_reset', u.username, 'local'); console.log(`Two-step verification turned off for ${u.username}.`); break; }
    case 'unlock': { const u = need(); db.unlockUser(u.username); db.audit('cli', 'cli.unlock', u.username, 'local'); console.log(`Unlocked ${u.username}.`); break; }
    case 'promote': { const u = need(); db.updateUser(u.id, { role: 'admin' }); db.audit('cli', 'cli.promote', u.username, 'local'); console.log(`${u.username} is now an administrator.`); break; }
    case 'backup': console.log('Backup written:', await db.backupNow()); break;
    default:
      console.log('Usage: node scripts/admin-cli.js list-users | reset-password <user> | reset-mfa <user> | unlock <user> | promote <user> | backup');
      process.exit(cmd ? 1 : 0);
  }
  db.db.close();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
