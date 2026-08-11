import { z } from "zod";

const relativePackagePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:\//u.test(value) &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "relativePackagePath must be a safe relative path"
  );

export const ownerPackageLocatorSchema = z
  .object({
    strategy: z.literal("host_relative_package"),
    relativePackagePath: relativePackagePathSchema
  })
  .strict();

export type OwnerPackageLocator = z.infer<typeof ownerPackageLocatorSchema>;
