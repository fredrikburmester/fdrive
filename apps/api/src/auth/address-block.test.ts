import { describe, expect, it } from "vitest";
import { addressBlock } from "./address-block";

describe("addressBlock", () => {
  it("leaves an IPv4 address as its own block", () => {
    expect(addressBlock("203.0.113.9")).toBe("203.0.113.9");
    expect(addressBlock(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(addressBlock("203.0.113.10")).not.toBe(addressBlock("203.0.113.9"));
  });

  it("folds every address of one IPv6 /64 onto the same block", () => {
    const block = addressBlock("2001:db8:1:2:3:4:5:6");
    expect(block).toBe("2001:db8:1:2::/64");
    expect(addressBlock("2001:db8:1:2::ffff")).toBe(block);
    // Case, elision and leading zeros are all the same address.
    expect(addressBlock("2001:0DB8:0001:0002:0000:0000:0000:0001")).toBe(block);
  });

  it("keeps different /64s apart, including neighbours in the same /48", () => {
    expect(addressBlock("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(addressBlock("2001:db8:1:3::1")).not.toBe(addressBlock("2001:db8:1:2::1"));
  });

  it("compresses an all-zero or partially zero prefix", () => {
    expect(addressBlock("::1")).toBe("::/64");
    expect(addressBlock("2001:db8::1")).toBe("2001:db8::/64");
    expect(addressBlock("2001:db8:0:1::1")).toBe("2001:db8:0:1::/64");
  });

  it("resolves IPv4-mapped addresses to the IPv4 address they carry", () => {
    expect(addressBlock("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressBlock("::ffff:cb00:7109")).toBe("203.0.113.9");
    expect(addressBlock("0:0:0:0:0:ffff:203.0.113.9")).toBe("203.0.113.9");
    // Mapped and plain forms of one address must not get separate budgets.
    expect(addressBlock("::ffff:203.0.113.9")).toBe(addressBlock("203.0.113.9"));
  });

  it("ignores the brackets, port and zone id an address can arrive with", () => {
    expect(addressBlock("[2001:db8:1:2::1]:44321")).toBe("2001:db8:1:2::/64");
    expect(addressBlock("fe80::1%eth0")).toBe("fe80::/64");
    expect(addressBlock("[fe80::1%eth0]")).toBe("fe80::/64");
  });

  it("returns anything it cannot parse untouched", () => {
    // `extractClientIp`'s last-resort value, and whatever a misconfigured
    // proxy may put in `x-forwarded-for`.
    expect(addressBlock("unknown")).toBe("unknown");
    expect(addressBlock("client.example.test")).toBe("client.example.test");
    expect(addressBlock("203.0.113.9:44321")).toBe("203.0.113.9:44321");
    expect(addressBlock("")).toBe("");
  });
});
