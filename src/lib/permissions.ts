// The fixed permission catalogue (report section 7 + "All records" from the Q12 decision), in sidebar order.
// Page permissions gate their page and endpoints; "all_records" is not a page: it lifts the own-records scope on
// leads, follow-ups, customers and the dashboard.
export const PERMISSIONS = [
  { code: "dashboard", label: "Dashboard" },
  { code: "leads", label: "Leads" },
  { code: "customers", label: "Customers" },
  { code: "follow_ups", label: "Follow Ups" },
  { code: "users", label: "Users" },
  { code: "notifications", label: "Notifications" },
  { code: "calculator", label: "DTDC Calculator" },
  { code: "modules", label: "Modules" },
  { code: "settings", label: "Settings" },
  { code: "all_records", label: "All Records" },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]["code"];
export const PERMISSION_CODES = PERMISSIONS.map((p) => p.code) as [PermissionCode, ...PermissionCode[]];
