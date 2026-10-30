# Handle a secret that reached a session

An API key, a token or a password that you pasted into an AI session is in that
tool's transcript on your disk. chat-recall masks it before the transcript
leaves the machine, and records a finding on the server. This guide finds the
finding, removes the risk and closes it.

## Find the leaked secrets

Open the **Security** view of the web app, or ask an assistant:

> Do I have any leaked secrets?

The assistant calls `recall_security_summary`. It lists each distinct secret,
by its masked preview, with the detectors that found it.

To see the exact lines, ask for the session. The assistant calls
`recall_security_session` with the session id.

## Remove the risk

1. Rotate the secret at its provider: make a new key, then revoke the old one.
2. Store the new key where your tools read it, and keep it out of chat. A
   secrets manager with a run command, such as sealkeep, gives the key to a
   command without the agent seeing it.
3. If the old key was used in other places, update them.

The masked copy on the server is not a risk. The plain copy is in the
transcript file of your AI tool, on your disk.

## Close the finding

Tell the assistant that the key was rotated. It calls `recall_security_dismiss`
with the status `rotated`. If the match is not a real secret, it uses
`false_positive`. The dismissal applies on all your devices.
`undismissed` puts a finding back on the list.

## Find more kinds of secrets

chat-recall detects the published formats of common providers. To add two
external detectors, gitleaks and trufflehog:

```bash
chat-recall detectors install
```

The command downloads pinned versions and verifies them. `chat-recall
detectors status` shows them, and `chat-recall detectors remove` removes them.

For a token format of your own, add a custom rule in the **Security** view. An
assistant tests a regex first with `recall_security_rules` and `action: "test"`.

For how detection works, see [Secret detection](./SECRET-DETECTION.md).
