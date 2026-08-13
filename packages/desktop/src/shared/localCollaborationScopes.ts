import { z } from "zod";
import { loopbackServerStatusSchema } from "@planweave-ai/collaboration-protocol/loopback";

const scopeIdentifierSchema = z.string().trim().min(1).max(128);

export const LOCAL_COLLABORATION_PROFILE_PREFIX = "planweave-local-";

export function isLocalCollaborationProfileId(profileId: string): boolean {
  return profileId.startsWith(LOCAL_COLLABORATION_PROFILE_PREFIX);
}

export const localCollaborationScopeSchema = z
  .object({
    projectId: scopeIdentifierSchema,
    canvasId: scopeIdentifierSchema
  })
  .strict();

export type LocalCollaborationScope = z.infer<typeof localCollaborationScopeSchema>;

export const localCollaborationScopeSelectionInputSchema = z
  .object({
    scopes: z.array(localCollaborationScopeSchema).max(256)
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<string>();
    input.scopes.forEach((scope, index) => {
      const key = `${scope.projectId}\0${scope.canvasId}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "local_collaboration_scope_duplicate",
          path: ["scopes", index]
        });
      }
      seen.add(key);
    });
  });

export type LocalCollaborationScopeSelectionInput = z.infer<
  typeof localCollaborationScopeSelectionInputSchema
>;

export const localCollaborationRegistrationInputSchema = z
  .object({
    profileId: scopeIdentifierSchema
      .refine(isLocalCollaborationProfileId, "local_collaboration_profile_required")
      .optional(),
    ownerDisplayName: z.string().trim().min(1).max(120).optional(),
    selection: localCollaborationScopeSchema.optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.profileId && input.selection) {
      context.addIssue({
        code: "custom",
        message: "local_collaboration_registration_target_conflict",
        path: ["profileId"]
      });
    }
  });

export type LocalCollaborationRegistrationInput = z.infer<
  typeof localCollaborationRegistrationInputSchema
>;

export type LocalCollaborationCanvasCatalogItem = {
  canvasId: string;
  name: string;
  selected: boolean;
  current: boolean;
};

export type LocalCollaborationProjectCatalogItem = {
  projectId: string;
  name: string;
  selectedCanvasCount: number;
  canvases: LocalCollaborationCanvasCatalogItem[];
};

export type LocalCollaborationScopeCatalog = {
  projects: LocalCollaborationProjectCatalogItem[];
  selectedCount: number;
};

export const localCollaborationLanSharingInputSchema = z.object({ enabled: z.boolean() }).strict();
export type LocalCollaborationLanSharingInput = z.infer<
  typeof localCollaborationLanSharingInputSchema
>;

export const localCollaborationServerStatusSchema = loopbackServerStatusSchema
  .extend({
    lanSharingEnabled: z.boolean(),
    lanServerBaseUrl: z.string().url().nullable()
  })
  .strict();
export type LocalCollaborationServerStatus = z.infer<typeof localCollaborationServerStatusSchema>;
