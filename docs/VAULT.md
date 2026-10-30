# Back up your chats with the Vault

The Vault keeps an encrypted copy of your AI sessions on the server, and puts
them back on another machine. The encryption happens on your machine, with a key
from your passphrase. The server stores only the encrypted data and cannot read
it.

The Vault is separate from the normal sync. The normal sync sends masked text
that the server can search. The Vault sends a full copy that only your machines
can read.

## Turn on the Vault

> **Caution:** Keep your passphrase safe. Without it, nobody can decrypt the
> backup, and the server cannot reset it.

```bash
chat-recall vault enable
```

The command asks for a passphrase. It makes a salt for your account and keeps
it on the server, and it stores the passphrase in the OS keyring, so the background service can encrypt
without you. Use `--no-keyring` to keep the passphrase out of the keyring; then
the service cannot decrypt.

On Linux, the keyring needs `secret-tool` (package `libsecret-tools`). macOS and
Windows have their keyring built in.

## Back up

```bash
chat-recall vault sync
```

The command encrypts the new and changed sessions and uploads them.

## Restore on another machine

1. Install chat-recall and log in with the same account.
2. Turn on the Vault with the same passphrase. The command gets the salt of
   your account from the server, so the passphrase is all it needs, and it
   stops with an error when the passphrase is wrong:

   ```bash
   chat-recall vault enable
   ```

3. Download and decrypt:

   ```bash
   chat-recall vault restore
   ```

The sessions go where chat-recall can index them. `--since <ms>` restores only
the backups after that time.

## Check and remove

`chat-recall vault status` shows whether the Vault is on, the fingerprint of the
salt, the time of the last backup, and whether this machine can decrypt without
you.

`chat-recall vault forget` removes the passphrase from this machine's keyring.
The Vault stays on, and you give the passphrase again for the next restore.

## How it is encrypted

The key comes from the passphrase with Argon2id (64 MiB of memory, 3
iterations). Each session is encrypted with XChaCha20-Poly1305 and a random
nonce. The passphrase and the key never leave your machine.
