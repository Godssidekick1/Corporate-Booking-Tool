// The roles a client's people can hold.
//   admin     the corporate admin: runs the company's side of the CBT (its
//             users and settings, and booking for colleagues where the client
//             self-books). A client may have several; it must keep at least
//             one active one, or nobody at the company can manage it.
//   finance   approves where a chain names finance, and sees spend reports.
//   employee  travels and books for themselves.
export const CLIENT_ROLES = ['employee', 'finance', 'admin'] as const
export type ClientRole = typeof CLIENT_ROLES[number]

export const CLIENT_ROLE_LABEL: Record<ClientRole, string> = {
  admin: 'Corporate admin',
  finance: 'Finance',
  employee: 'Employee',
}

export function isClientRole(value: unknown): value is ClientRole {
  return typeof value === 'string' && (CLIENT_ROLES as readonly string[]).includes(value)
}
