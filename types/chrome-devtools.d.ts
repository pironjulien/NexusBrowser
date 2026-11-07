// Types for the type check of the extension (tsconfig.json), never shipped. chrome.debugger.sendCommand with a known
// Chrome DevTools Protocol method takes that method's parameters and resolves to its result (devtools-protocol, the
// protocol's own generated types); a method computed at run time keeps @types/chrome's generic signature.
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";

declare global {
    namespace chrome.debugger {
        function sendCommand<M extends keyof ProtocolMapping.Commands>(
            target: DebuggerSession,
            method: M,
            ...commandParams: ProtocolMapping.Commands[M]["paramsType"]
        ): Promise<ProtocolMapping.Commands[M]["returnType"]>;
    }
}

export {};
