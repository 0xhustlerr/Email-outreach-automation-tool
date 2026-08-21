# Email Outreach

Automated cold-outreach: discovers leads, scores their addresses, and works them through a two-step email sequence from a pool of sending accounts.

## Language

### Sequencing

**Sequence**:
The two-step outreach a contact receives: an Opener, then either a Pitch (if they reply) or Bumps (if they don't).
_Avoid_: campaign, drip

**Opener**:
The first-touch email of a Sequence, sent on a drip from the pool of senders.
_Avoid_: first email, initial send

**Pitch**:
The full pitch sent to a contact who replied to their Opener. Takes priority over all other sending.
_Avoid_: follow-up, hot pitch, reply follow-up

**Bump**:
A short link-free nudge sent to a contact who has not replied to their Opener after a delay.
_Avoid_: reminder, nudge, follow-up

**Lane**:
One of the three kinds of send the worker can perform on a tick: Pitch, Opener, or Bump — in that priority order.
_Avoid_: channel, track, queue (for a single lane)

### Scheduling

**Send plan**:
The ordered projection of every queued item: when each is expected to send, or the Hold reason keeping it back. Computed in one place; the worker executes it and the UI renders it.
_Avoid_: schedule, forecast, estimate

**Hold reason**:
The single typed cause keeping an item from sending right now (e.g. sending window closed, daily cap reached, sender blocked, offline).
_Avoid_: block (that's a Sender block), status, wait state

**Claim**:
The transactional act of taking exactly one due item from the database for sending. A Claim is the authority on what actually sends; the Send plan only predicts it.
_Avoid_: lock, pop, dequeue

### Sending accounts

**Sender**:
A connected SMTP account that Sequences are sent from, rotated across sends.
_Avoid_: inbox (that's where replies arrive), account, identity

**Sender block**:
A Sender stood down for the rest of the day after a policy bounce or failed login.
_Avoid_: pause, suspension
