# Security policy

NexusBrowser drives the user's real Chrome with their own sessions, so safety issues matter more than usual: a way
for an agent to act in a tab it did not open (or adopt with the user's consent), to reach the local bridge without
its token, to read a password, card number or security code that should be masked (text, screenshots, PDF, network
log, console), or to keep acting during the emergency stop.

Please report such issues privately through
[GitHub private vulnerability reporting](https://github.com/pironjulien/NexusBrowser/security/advisories/new),
not in a public issue. Include the tool call, the page involved (without personal data) and what happened. You will
get an answer within a few days.

Only the latest release is supported.
