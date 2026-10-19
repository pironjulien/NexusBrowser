# Security policy

NexusBrowser drives the user's real Chrome with their own sessions, so safety issues matter more than usual: a way
for an agent to act in a tab it did not open (or adopt with the user's consent), to reach the local bridge without
its token, to read a password, card number or security code that should be masked (text, screenshots, PDF, network
log, console), or to keep acting during the emergency stop.

An outward gesture (a click, Enter, Space, a typed line break or a drag whose trigger says send, pay, order, publish,
call, transfer...) that runs without `confirm=true` and the one-time accord token bound to that exact action is a
vulnerability too. Known and accepted on purpose: `browser_eval` and `browser_cdp_send` (`Runtime.evaluate`,
`Input.dispatch*`) have full page access and do not go through that accord; bare coordinates of
`browser_drag_and_drop` are not read; the page may change between the trigger read and the gesture.

Please report such issues privately through
[GitHub private vulnerability reporting](https://github.com/pironjulien/NexusBrowser/security/advisories/new),
not in a public issue. Include the tool call, the page involved (without personal data) and what happened. You will
get an answer within a few days.

Only the latest release is supported.
