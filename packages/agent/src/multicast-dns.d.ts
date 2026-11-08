// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal shape of the multicast-dns socket the browser uses. Kept in sync
// with `MdnsSocketLike` in mdns.ts by hand; both are small and structural, so
// a drift breaks the default factory assignment at compile time.
declare module "multicast-dns" {
  function multicastDns(options?: {
    port?: number;
    type?: "udp4" | "udp6";
    ip?: string;
    reuseAddr?: boolean;
    multicast?: boolean;
    loopback?: boolean;
    ttl?: number;
  }): {
    query(questions: readonly { name: string; type: string }[]): void;
    on(
      event: "response",
      handler: (
        response: {
          answers?: readonly {
            name: string;
            type: string;
            ttl: number;
            data: unknown;
          }[];
          additionals?: readonly {
            name: string;
            type: string;
            ttl: number;
            data: unknown;
          }[];
        },
        rinfo: { address?: string },
      ) => void,
    ): void;
    destroy(): void;
  };
  export default multicastDns;
}
