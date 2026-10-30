# Connect claude.ai or ChatGPT

An assistant that cannot run the chat-recall CLI, such as claude.ai, ChatGPT or
a browser IDE, connects to the remote MCP endpoint of your server. It signs in
with OAuth and then uses the same tools as the local MCP server.

## Connect an assistant to chatrecall.dev

1. Open the connector settings of the assistant and add a custom connector.
2. Enter the URL:

   ```
   https://chatrecall.dev/mcp
   ```

3. The assistant opens the sign-in page of chatrecall.dev. Sign in with the
   account that your machines sync to.
4. The consent page names the assistant. Select **Allow**.

The assistant can now search and read your history. Ask it, for example, "What
did I work on last week?"

## What the connector can do

The remote endpoint serves the same tool set as the local MCP server, with two
exceptions: `recall_index` and `recall_code_index` read the caller's own disk,
and a remote assistant has no disk on your machine, so the endpoint does not
list them. The sync still runs from your machines.

The connection stays signed in. The assistant refreshes its access with a
refresh token, and you do not sign in again.

## Disconnect an assistant

Remove the connector in the settings of the assistant. Its tokens stop working
when they expire, and a removed connector cannot refresh them.

## Connect an assistant to your own server

A self-hosted server serves the endpoint at `https://<your server>/mcp`. The
endpoint exists only when the server runs with `AUTH_PROVIDER=better-auth`,
because the OAuth sign-in comes from that provider. That provider gives each
person an account, so a self-hosted server needs a licence that includes
`team` for it. See
[Self-hosting](./SELF_HOSTING.md) and [Environment variables](./ENVIRONMENT.md).

An assistant that runs in the cloud can reach the server only over the public
internet, so the server needs a public HTTPS address.
