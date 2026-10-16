-- The Modules page gets its own permission, like every other page. Every existing role is granted it, so nobody
-- loses the page they could open before; admins can then remove it per role in Users → Roles.
INSERT INTO "permissions" ("code", "label") VALUES ('modules', 'Modules')
ON CONFLICT ("code") DO UPDATE SET "label" = EXCLUDED."label";

INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'modules' FROM "roles"
ON CONFLICT DO NOTHING;
