import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { listingMediaPrefix, MEDIA_CACHE_CONTROL, MEDIA_CONTENT_TYPE, mediaObjectKey, photoUrl, quarantineObjectKey } from "@/lib/media/urls";
import { isValidObjectKey } from "@/lib/storage/keys";

describe("media object keys and URLs", () => {
  it("builds the D6 keys, valid for every ObjectStore", () => {
    expect(mediaObjectKey("abcd2345", "u1234567890", "l")).toBe("listings/abcd2345/u1234567890-l.webp");
    expect(mediaObjectKey("abcd2345", "u1234567890", "s")).toBe("listings/abcd2345/u1234567890-s.webp");
    expect(listingMediaPrefix("abcd2345")).toBe("listings/abcd2345/");
    expect(quarantineObjectKey("u1234567890")).toBe("uploads/u1234567890");
    expect(isValidObjectKey(mediaObjectKey("abcd2345", "u1234567890", "l"))).toBe(true);
    expect(isValidObjectKey(quarantineObjectKey("u1234567890"))).toBe(true);
    expect(MEDIA_CONTENT_TYPE).toBe("image/webp");
    expect(MEDIA_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
  });

  it("serves photos from MEDIA_BASE_URL, the dev route in development, nowhere otherwise", () => {
    expect(photoUrl(parseEnv({}).env, "abcd2345", "u1234567890", "s")).toBe("http://localhost:3000/api/dev/storage/joutiya-dev-media/listings/abcd2345/u1234567890-s.webp");
    expect(photoUrl(parseEnv({ MEDIA_BASE_URL: "https://media.joutiya.ma/" }).env, "abcd2345", "u1234567890", "l")).toBe(
      "https://media.joutiya.ma/listings/abcd2345/u1234567890-l.webp",
    );
    expect(photoUrl(parseEnv({ APP_ENV: "prod", SITE_URL: "https://joutiya.ma" }).env, "abcd2345", "u1234567890", "l")).toBeNull();
  });
});
