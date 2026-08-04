function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function migrateRetiredPrivateHttpsProfileEndpoints(input: unknown): {
  input: unknown;
  migrated: boolean;
} {
  if (!isRecord(input) || !Array.isArray(input.profiles)) {
    return { input, migrated: false };
  }

  let migrated = false;
  const profiles = input.profiles.map((profile) => {
    if (!isRecord(profile) || !isRecord(profile.endpoint)) {
      return profile;
    }
    const topology = profile.endpoint.topology;
    if (topology !== "tailscale_https" && topology !== "lan_https") {
      return profile;
    }
    migrated = true;
    return {
      ...profile,
      endpoint: {
        ...profile.endpoint,
        topology: "private_https"
      }
    };
  });

  return migrated
    ? {
        input: { ...input, profiles },
        migrated: true
      }
    : { input, migrated: false };
}
