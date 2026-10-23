# Installer UX notes

What well-loved installers do, and what we took from each. Sources: rustup, Homebrew,
Tailscale, Coolify, Dokploy, Mail-in-a-Box, mailcow, the Supabase, Railway and Fly CLIs, and
charm's gum (as a pattern; we add no dependency).

1. **Say what will change before it changes (rustup, Homebrew).** Both print a short plan and
   wait for Enter. We print what is installed, which ports are used, where secrets live, and
   how to undo it, then ask once. `--yes` / `ASSUME_YES=1` skips the question.
2. **One confirmation, not ten (Homebrew, Coolify).** After the plan is accepted, the script
   runs without further "are you sure" prompts. Only real choices are asked.
3. **Read from /dev/tty under `curl | bash` (rustup, Homebrew, Coolify).** stdin is the script,
   so every prompt reads and writes the terminal explicitly. With no terminal we use defaults
   or stop with the exact flag to pass.
4. **Defaults in brackets, Enter accepts, bad input re-asks (gum, Fly CLI).** `Domain [none]:`
   and `Admin mailbox [admin@example.com]:`. A typo never aborts the install.
5. **Numbered steps with a result per step (Dokploy, mailcow).** `[3/7] Build images ... ok`.
   People know how far along they are and which step failed.
6. **Hide long output behind a spinner and keep a log (gum spin, Tailscale, Coolify).** Image
   builds can take minutes and print thousands of lines. We show a spinner and write the full
   output to `/opt/5050-mail/install.log`. On failure, the last lines and the log path.
7. **Errors say what to do next (Fly, Railway, Supabase CLIs).** Not "failed", but "port 25 is
   blocked by AWS; here is the form, or pick a relay". Every `die` names a fix or a flag.
8. **Link straight to the right page (Tailscale, Supabase).** Tailscale prints the exact auth
   URL. We print `dash.cloudflare.com/profile/api-tokens`, with a pre-filled template link
   where Cloudflare supports one.
9. **Paste a secret once, hidden, and verify it right away (Railway, Fly).** Check the token
   before any change, say which permission is missing by its dashboard name, and let the user
   fix it and press Enter to re-check instead of starting over.
10. **Detect, then ask only what you cannot detect (Mail-in-a-Box, mailcow).** Mail-in-a-Box
    derives hostnames and checks DNS itself; mailcow checks ports and memory first. We detect
    the Cloudflare zone from the token, the public IP, port 25, and the cloud provider.
11. **Show the DNS records as a table and re-check them for the user (Mail-in-a-Box status
    page).** A "Check DNS" loop that waits until records resolve, and can be skipped, replaces
    "go away and good luck".
12. **Never overwrite what is already there (Mail-in-a-Box, mailcow).** Existing SPF and DMARC
    are merged or kept, never duplicated. A conflicting MX is shown and replaced only after a yes.
13. **Colour with restraint, and respect the environment (gum, Homebrew).** Colour only on a TTY,
    off for `NO_COLOR` and `TERM=dumb`, ASCII fallbacks when the locale is not UTF-8. Colour
    carries status (green ok, red failed, yellow warning), never decoration.
14. **End with one screen to screenshot (Coolify, Dokploy).** URLs, the one-time password, next
    steps, log location. Warn about the password where the user is looking.
15. **Re-runs are boring (Homebrew, Tailscale).** Running the installer again keeps secrets,
    skips finished work, and says "already done" instead of repeating it.

Copy rules (from the anti-slop guide): plain words, no hype, no emoji except the check and
cross marks, no exclamation marks, say what happens and what the user does next.

Cloudflare facts used (checked against developers.cloudflare.com, October 2026):

- Token verify: `GET /user/tokens/verify` (user tokens) and `GET /accounts/{id}/tokens/verify`
  (account-owned tokens).
- Template URL: `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=<json>&accountId=*&zoneId=all&name=...`,
  keys such as `dns` and `zone`; the page only pre-fills the form.
- Email Sending over SMTP and REST needs a token with **Email Sending: Edit**; account-owned tokens
  are recommended by Cloudflare. The permission-group key for it is not in the published
  template-URL table, so the link pre-fills DNS and Zone and the guide says to add Email Sending by hand.
