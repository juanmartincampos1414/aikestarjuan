import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ShieldAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ROLE_LABELS,
  PERMISSION_LABELS,
  PERMISSION_MIN_ROLE,
  type Role,
  type Permission,
} from "@shared/schema";

interface PermissionDeniedDetail {
  userRole?: Role;
  requiredPermission?: Permission;
  requiredRole?: Role;
  message?: string;
}

export default function PermissionDeniedDialog() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<PermissionDeniedDetail | null>(null);

  useEffect(() => {
    function handler(e: Event) {
      const ce = e as CustomEvent<PermissionDeniedDetail>;
      setDetail(ce.detail || {});
      setOpen(true);
    }
    window.addEventListener("aikestar:permission-denied", handler);
    return () => window.removeEventListener("aikestar:permission-denied", handler);
  }, []);

  const userRoleLabel = detail?.userRole ? ROLE_LABELS[detail.userRole] : null;
  const actionLabel = detail?.requiredPermission ? PERMISSION_LABELS[detail.requiredPermission] : null;
  const minRole =
    detail?.requiredRole ??
    (detail?.requiredPermission ? PERMISSION_MIN_ROLE[detail.requiredPermission] : undefined);
  const minRoleLabel = minRole ? ROLE_LABELS[minRole] : null;

  const goToTeam = () => {
    setOpen(false);
    setLocation("/settings?tab=team");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-permission-denied">
        <DialogHeader>
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-rose-500/10 mb-2">
            <ShieldAlert className="h-7 w-7 text-rose-500" />
          </div>
          <DialogTitle className="text-center text-xl" data-testid="text-permission-denied-title">
            No tenés permiso para esta acción
          </DialogTitle>
          <DialogDescription className="text-center pt-2 text-base text-foreground/80">
            {actionLabel ? (
              <>
                Tu rol actual no te permite{" "}
                <span className="font-semibold text-foreground">{actionLabel}</span>.
              </>
            ) : (
              <>Tu rol actual no te permite realizar esta acción.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          {userRoleLabel && (
            <div className="rounded-lg border bg-muted/40 px-3 py-2 flex items-center justify-between">
              <span className="text-muted-foreground">Tu rol</span>
              <span className="font-medium" data-testid="text-permission-denied-user-role">
                {userRoleLabel}
              </span>
            </div>
          )}
          {minRoleLabel && (
            <div className="rounded-lg border bg-muted/40 px-3 py-2 flex items-center justify-between">
              <span className="text-muted-foreground">Rol mínimo necesario</span>
              <span className="font-medium" data-testid="text-permission-denied-required-role">
                {minRoleLabel}
              </span>
            </div>
          )}
          <p className="text-muted-foreground leading-relaxed">
            Pedile al <span className="font-medium text-foreground">Propietario</span> o a un{" "}
            <span className="font-medium text-foreground">Administrador</span> de la organización
            que cambie tu rol desde <span className="font-medium text-foreground">Configuración → Equipo</span>{" "}
            si necesitás hacer esta acción.
          </p>
        </div>

        <DialogFooter className="sm:justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={goToTeam}
            data-testid="button-permission-denied-go-team"
          >
            Ver mi rol
          </Button>
          <Button
            type="button"
            onClick={() => setOpen(false)}
            data-testid="button-permission-denied-close"
          >
            Entendido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
