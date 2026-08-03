import { z } from "zod";
import { loopbackServerStatusSchema } from "@planweave-ai/collaboration-protocol/loopback";

const scopeIdentifierSchema = z.string().trim().min(1).max(128);

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
    ownerDisplayName: z.string().trim().min(1).max(120).optional(),
    selection: localCollaborationScopeSchema.optional()
  })
  .strict();

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
