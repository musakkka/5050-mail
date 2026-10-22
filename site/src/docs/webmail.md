---
title: Webmail guide
description: Using the 5050 Mail webmail, from the inbox and compose to labels, snooze, settings and keyboard shortcuts.
---

# Webmail guide

The webmail at `https://mail.example.com` works like Gmail on purpose: if your team knows Gmail, they already know where everything is. Sign in with your full email address and password.

## The inbox

The left menu has **Inbox**, **Starred**, **Snoozed**, **Sent**, **Drafts** and, under **More**, the remaining folders, followed by your **Labels**. The **Inbox** is split into category tabs (**Primary**, **Promotions**, **Social**, **Updates**, **Forums**) when the inbox type is **Default**; switch them on or off in **Settings → Inbox**.

Each row shows the sender, subject, a snippet, label chips and attachment chips. Hover a row for quick actions (archive, delete, mark as read, snooze). Select several with the checkboxes and use the toolbar above the list.

Conversations are threaded: replies are grouped with the message they answer. Turn **Conversation View** off in Settings to see every message on its own.

## Reading

Open a conversation to read it. Remote images are shown or held back according to **Settings → Images**. Attachments show as chips with a preview; images and PDFs open in a viewer.

The **reading pane** can sit to the right of the list or below it instead of replacing it: choose in the quick settings (the gear icon), together with **density** (default, comfortable, compact) and **theme** (light, dark or system).

## Writing

**Compose** opens a message window at the bottom of the screen; you can keep several open, minimise them, or expand one. Recipients autocomplete from your contacts as you type.

- Attach files with the paper clip, or drag them onto the message.
- **Schedule send** (the arrow next to **Send**) delivers the message at a time you choose.
- **Undo Send** holds every message for a few seconds after you press **Send**. Choose 5, 10, 20 or 30 seconds in Settings.
- Your **signature** is added to new messages; set it in **Settings → General**.

Drafts save automatically.

## Organising

- **Labels**: create them from **Labels → +** in the left menu. Labels can be nested (`Projects/Website`). A conversation can carry several labels; filing one under a label is like a folder that doesn't remove it from the others.
- **Archive** removes a conversation from the inbox and keeps it in **All mail**.
- **Star** and **Important** mark what matters.
- **Snooze** hides a conversation until a time you pick, then brings it back to the top of the inbox.
- **Mute** keeps new replies to a conversation out of your inbox.
- **Report spam** moves it to Spam.

> [!NOTE]
> Snooze wake-ups and moving delivered scheduled mail to Sent run on the server, using your own session: they happen while you are signed in, and right after you sign in again. Until then, mail apps over IMAP still see a snoozed message in the Snoozed folder.

## Search

Type in the search bar at the top. The filter icon at its right opens advanced search: from, to, subject, words, has attachment, and date ranges.

## Settings

Open the gear icon, then **See all settings**.

| Tab | Settings |
|---|---|
| General | Maximum page size, Undo Send, default reply behaviour, hover actions, keyboard shortcuts, images, desktop notifications, signature, vacation responder, snippets |
| Inbox | Inbox type (default, important first, unread first, starred first), categories, importance markers, reading pane |
| Labels | Show, hide or show-if-unread for each label in the menu |
| Advanced | Notes on how snooze and scheduled mail are processed |

The **vacation responder** is stored on the server, so it answers even when nobody has the webmail open.

## Keyboard shortcuts

Turn shortcuts on in **Settings → General → Keyboard shortcuts**, then press <kbd>?</kbd> for the full list. The most used:

| Keys | Action |
|---|---|
| <kbd>c</kbd> | Compose |
| <kbd>/</kbd> | Search mail |
| <kbd>j</kbd> / <kbd>k</kbd> | Older / newer conversation |
| <kbd>o</kbd> or <kbd>Enter</kbd> | Open conversation |
| <kbd>u</kbd> | Back to the list |
| <kbd>e</kbd> | Archive |
| <kbd>#</kbd> | Delete |
| <kbd>r</kbd>, <kbd>a</kbd>, <kbd>f</kbd> | Reply, reply all, forward |
| <kbd>s</kbd> | Star |
| <kbd>b</kbd> | Snooze |
| <kbd>l</kbd> | Label as |
| <kbd>v</kbd> | Move to |
| <kbd>x</kbd> | Select conversation |
| <kbd>Shift</kbd> + <kbd>i</kbd> / <kbd>Shift</kbd> + <kbd>u</kbd> | Mark as read / unread |
| <kbd>z</kbd> | Undo last action |
| <kbd>g</kbd> then <kbd>i</kbd> | Go to Inbox (also <kbd>s</kbd> Starred, <kbd>t</kbd> Sent, <kbd>d</kbd> Drafts, <kbd>a</kbd> All mail) |

## Mail apps on desktop and phone

Every mailbox also works in Apple Mail, Outlook, Thunderbird, and the mail apps on iOS and Android:

| | Server | Port | Security |
|---|---|---|---|
| Incoming (IMAP) | `mail.example.com` | 993 | SSL/TLS |
| Outgoing (SMTP) | `mail.example.com` | 465 | SSL/TLS |
| Outgoing (alternative) | `mail.example.com` | 587 | STARTTLS |

The username is the full email address. Mail, labels-as-folders and read state stay in sync between the apps and the webmail.
