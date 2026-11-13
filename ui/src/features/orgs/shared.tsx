import type { OrgDetail, Role } from "@shared/orgs";
import type { JSX } from "solid-js";
import { Show } from "solid-js";

export const isAdmin = (detail: OrgDetail): boolean =>
  detail.me.role === "owner" || detail.me.role === "admin";

export function FormError(props: { message: string | null }): JSX.Element {
  return (
    <Show when={props.message}>
      {(message) => (
        <p class="form-error" role="alert">
          {message()}
        </p>
      )}
    </Show>
  );
}

export const ROLES: Role[] = ["owner", "admin", "member", "viewer"];
