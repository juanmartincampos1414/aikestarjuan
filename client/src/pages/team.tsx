import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, UserPlus, Shield, Eye, Edit3, Trash2, Crown, Loader2, Briefcase, ChevronDown, Mail, Clock, RefreshCw, Copy, X, Wand2, UserCheck } from "lucide-react";
import { fetchWithAuth } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { ROLES, ASSIGNABLE_ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, ROLE_PERMISSIONS, ROLE_CAPABILITIES, type Role, type Permission } from "@shared/schema";
import { Check, X as XIcon } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";

interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

interface InviteCredentials {
  email: string;
  temporaryPassword: string;
}

interface EmailCheckResult {
  exists: boolean;
  name?: string;
  alreadyMember?: boolean;
}

interface InviteResponse {
  type: 'existing_user' | 'new_invitation';
  email: string;
  name?: string;
  temporaryPassword?: string;
  invitationId?: string;
  membershipId?: string;
  message?: string;
}

function getRoleBadgeVariant(role: string): "default" | "secondary" | "outline" | "destructive" {
  switch (role) {
    case "owner":
      return "destructive";
    case "admin":
      return "default";
    case "specialist":
      return "default";
    case "operator":
      return "secondary";
    default:
      return "outline";
  }
}

function getRoleIcon(role: string) {
  switch (role) {
    case "owner":
      return <Crown className="h-3 w-3" />;
    case "admin":
      return <Shield className="h-3 w-3" />;
    case "specialist":
      return <Briefcase className="h-3 w-3" />;
    case "operator":
      return <Edit3 className="h-3 w-3" />;
    default:
      return <Eye className="h-3 w-3" />;
  }
}

export default function TeamPage({ embedded = false }: { embedded?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberPassword, setNewMemberPassword] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<Role>("operator");
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [deletingMember, setDeletingMember] = useState<Member | null>(null);

  const [credentials, setCredentials] = useState<InviteCredentials | null>(null);
  const [cancellingInvitation, setCancellingInvitation] = useState<Invitation | null>(null);
  const [emailCheckResult, setEmailCheckResult] = useState<EmailCheckResult | null>(null);
  const [isCheckingEmail, setIsCheckingEmail] = useState(false);

  const generatePassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  };

  // Check if email exists when user types
  useEffect(() => {
    const checkEmail = async () => {
      if (!newMemberEmail || !newMemberEmail.includes('@')) {
        setEmailCheckResult(null);
        return;
      }
      
      setIsCheckingEmail(true);
      try {
        const result = await fetchWithAuth(`/team/check-email?email=${encodeURIComponent(newMemberEmail)}`);
        setEmailCheckResult(result);
      } catch {
        setEmailCheckResult(null);
      } finally {
        setIsCheckingEmail(false);
      }
    };

    const timeoutId = setTimeout(checkEmail, 500);
    return () => clearTimeout(timeoutId);
  }, [newMemberEmail]);

  const { data: members = [], isLoading } = useQuery<Member[]>({
    queryKey: ["/organization/members"],
    queryFn: () => fetchWithAuth("/organization/members"),
  });

  const { data: currentMembership } = useQuery({
    queryKey: ["/user/membership"],
    queryFn: () => fetchWithAuth("/user/membership"),
  });

  const { data: invitations = [], isLoading: isLoadingInvitations } = useQuery<Invitation[]>({
    queryKey: ["/team/invitations"],
    queryFn: () => fetchWithAuth("/team/invitations"),
    enabled: currentMembership?.role === 'owner',
  });

  const isOwner = currentMembership?.role === 'owner';
  const canManageTeam = isOwner;

  const { data: planLimits } = useQuery<{
    planType: string;
    planLabel: string;
    limits: { maxOrgs: number; maxMembersPerOrg: number };
    usage: { organizations: number; members: number };
    isTeamPlan: boolean;
  }>({
    queryKey: ["/subscription/limits"],
    queryFn: () => fetchWithAuth("/subscription/limits"),
  });

  const atMemberLimit = planLimits && planLimits.usage.members >= planLimits.limits.maxMembersPerOrg;

  const addMemberMutation = useMutation({
    mutationFn: (data: { email: string; role: string; password?: string }) =>
      fetchWithAuth("/team/invite", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: (data: InviteResponse) => {
      queryClient.invalidateQueries({ queryKey: ["/organization/members"] });
      queryClient.invalidateQueries({ queryKey: ["/team/invitations"] });
      setIsAddDialogOpen(false);
      setNewMemberEmail("");
      setNewMemberPassword("");
      setNewMemberRole("operator");
      setEmailCheckResult(null);
      
      if (data.type === 'existing_user') {
        toast({ 
          title: "Miembro agregado", 
          description: `${data.name || data.email} fue agregado a la organización` 
        });
      } else {
        setCredentials({ email: data.email, temporaryPassword: data.temporaryPassword! });
        toast({ title: "Invitación creada", description: "Se creó la cuenta para el nuevo integrante" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) =>
      fetchWithAuth(`/organization/members/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/organization/members"] });
      setEditingMember(null);
      toast({ title: "Rol actualizado", description: "El rol del miembro fue cambiado" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMemberMutation = useMutation({
    mutationFn: (id: string) =>
      fetchWithAuth(`/organization/members/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/organization/members"] });
      setDeletingMember(null);
      toast({ title: "Miembro eliminado", description: "El usuario fue removido del equipo" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });


  const regeneratePasswordMutation = useMutation({
    mutationFn: (id: string) =>
      fetchWithAuth(`/team/regenerate-password/${id}`, {
        method: "POST",
      }),
    onSuccess: (data: InviteCredentials) => {
      queryClient.invalidateQueries({ queryKey: ["/team/invitations"] });
      setCredentials(data);
      toast({ title: "Contraseña regenerada", description: "Se generó una nueva contraseña temporal" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const cancelInvitationMutation = useMutation({
    mutationFn: (id: string) =>
      fetchWithAuth(`/team/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/team/invitations"] });
      setCancellingInvitation(null);
      toast({ title: "Invitación cancelada", description: "La invitación fue eliminada" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const copyCredentialsToClipboard = () => {
    if (credentials) {
      const text = `Email: ${credentials.email}\nContraseña: ${credentials.temporaryPassword}`;
      navigator.clipboard.writeText(text);
      toast({ title: "Copiado", description: "Credenciales copiadas al portapapeles" });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <>
    <div className="space-y-4 sm:space-y-6" data-testid="team-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        {!embedded && (
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Equipo</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Gestiona los miembros de tu organización
            {planLimits && (
              <span className="ml-2 text-xs bg-muted px-2 py-0.5 rounded">
                {planLimits.usage.members}/{planLimits.limits.maxMembersPerOrg} miembros
              </span>
            )}
          </p>
        </div>
        )}
        {canManageTeam && planLimits && planLimits.limits.maxMembersPerOrg <= 1 && (
          <a href="/subscription" className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/20 rounded-lg transition-colors" data-testid="link-upgrade-team">
            <Users className="h-4 w-4" />
            Cambiar de plan
          </a>
        )}
        {canManageTeam && planLimits && planLimits.limits.maxMembersPerOrg > 1 && (
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button 
                data-testid="button-add-member" 
                className="w-full sm:w-auto"
                disabled={atMemberLimit}
                title={atMemberLimit ? `Alcanzaste el límite de ${planLimits?.limits.maxMembersPerOrg} miembros de tu plan` : undefined}
              >
                <UserPlus className="h-4 w-4 mr-2" />
                {planLimits.isTeamPlan ? 'Agregar Miembro' : 'Invitar'}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{planLimits?.isTeamPlan ? 'Agregar miembro' : 'Invitar persona'}</DialogTitle>
                <DialogDescription>
                  {emailCheckResult?.exists 
                    ? "Este usuario ya tiene cuenta. Se agregará directamente a tu organización."
                    : planLimits?.isTeamPlan 
                      ? "Ingresá el email del nuevo integrante del equipo"
                      : "Ingresá el email de la persona que querés invitar"
                  }
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Input
                      id="email"
                      type="email"
                      placeholder="usuario@ejemplo.com"
                      value={newMemberEmail}
                      onChange={(e) => setNewMemberEmail(e.target.value)}
                      data-testid="input-member-email"
                      className={emailCheckResult?.alreadyMember ? "border-destructive" : emailCheckResult?.exists ? "border-green-500" : ""}
                    />
                    {isCheckingEmail && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  {emailCheckResult?.exists && !emailCheckResult.alreadyMember && (
                    <div className="flex items-center gap-2 text-sm text-green-600">
                      <UserCheck className="h-4 w-4" />
                      <span>Usuario encontrado: {emailCheckResult.name}</span>
                    </div>
                  )}
                  {emailCheckResult?.alreadyMember && (
                    <p className="text-sm text-destructive">
                      Este usuario ya es miembro de esta organización
                    </p>
                  )}
                </div>
                
                {/* Only show password field for new users */}
                {!emailCheckResult?.exists && newMemberEmail.includes('@') && (
                  <div className="space-y-2">
                    <Label htmlFor="password">Contraseña</Label>
                    <div className="flex gap-2">
                      <Input
                        id="password"
                        type="password"
                        placeholder="Contraseña temporal"
                        value={newMemberPassword}
                        onChange={(e) => setNewMemberPassword(e.target.value)}
                        data-testid="input-member-password"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setNewMemberPassword(generatePassword())}
                        data-testid="button-generate-password"
                      >
                        <Wand2 className="h-4 w-4 mr-1" />
                        Generar
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Se creará una cuenta nueva para este usuario
                    </p>
                  </div>
                )}
                
                <div className="space-y-2">
                  <Label htmlFor="role">Rol</Label>
                  <Select value={newMemberRole} onValueChange={(v) => setNewMemberRole(v as Role)}>
                    <SelectTrigger data-testid="select-member-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ASSIGNABLE_ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          <div className="flex items-center gap-2">
                            {getRoleIcon(role)}
                            <span>{ROLE_LABELS[role]}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">
                    {ROLE_DESCRIPTIONS[newMemberRole]}
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { 
                  setIsAddDialogOpen(false); 
                  setNewMemberEmail(""); 
                  setEmailCheckResult(null); 
                }}>
                  Cancelar
                </Button>
                <Button
                  onClick={() => addMemberMutation.mutate({ 
                    email: newMemberEmail, 
                    role: newMemberRole,
                    password: emailCheckResult?.exists ? undefined : (newMemberPassword || undefined)
                  })}
                  disabled={!newMemberEmail || addMemberMutation.isPending || isCheckingEmail || emailCheckResult?.alreadyMember}
                  data-testid="button-confirm-add-member"
                >
                  {addMemberMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {emailCheckResult?.exists ? "Agregar a organización" : "Crear cuenta y agregar"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Collapsible defaultOpen>
        <Card data-testid="card-roles-guide">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
              <CardTitle className="flex items-center justify-between text-base">
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  <div>
                    <p>Guía de roles del equipo</p>
                    <p className="text-xs font-normal text-muted-foreground mt-0.5">
                      Qué puede y qué no puede hacer cada rol
                    </p>
                  </div>
                </div>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
              </CardTitle>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0">
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {ROLES.map((role) => {
                  const caps = ROLE_CAPABILITIES[role];
                  return (
                    <div
                      key={role}
                      className={`p-3 rounded-lg border flex flex-col gap-2 ${role === "admin" ? "border-primary/50 bg-primary/5" : "bg-muted/30"}`}
                      data-testid={`role-card-${role}`}
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant={getRoleBadgeVariant(role)} className="gap-1">
                          {getRoleIcon(role)}
                          {ROLE_LABELS[role]}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
                      {caps.can.length > 0 && (
                        <div className="text-xs space-y-1">
                          <p className="font-medium text-emerald-600 dark:text-emerald-400">Puede</p>
                          <ul className="space-y-1">
                            {caps.can.map((c, i) => (
                              <li key={i} className="flex items-start gap-1.5 text-foreground/80">
                                <Check className="h-3 w-3 mt-0.5 text-emerald-500 flex-shrink-0" />
                                <span>{c}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {caps.cannot.length > 0 && (
                        <div className="text-xs space-y-1">
                          <p className="font-medium text-rose-600 dark:text-rose-400">No puede</p>
                          <ul className="space-y-1">
                            {caps.cannot.map((c, i) => (
                              <li key={i} className="flex items-start gap-1.5 text-foreground/70">
                                <XIcon className="h-3 w-3 mt-0.5 text-rose-500 flex-shrink-0" />
                                <span>{c}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-4">
                Si un miembro recibe el aviso <span className="font-medium text-foreground">"No tenés permiso para esta acción"</span>,
                significa que su rol actual no incluye esa operación. Como Propietario o Administrador podés cambiarle el rol desde la lista de miembros más abajo.
              </p>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {canManageTeam && invitations.length > 0 && (
        <Card data-testid="pending-invitations-section">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Miembros Pendientes ({invitations.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 py-3 sm:py-4 first:pt-0 last:pb-0"
                  data-testid={`invitation-row-${invitation.id}`}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-gradient-to-br from-yellow-500 to-orange-500 flex items-center justify-center text-white font-medium text-sm sm:text-base flex-shrink-0">
                      <Mail className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm sm:text-base truncate">{invitation.email}</p>
                      <p className="text-xs sm:text-sm text-muted-foreground">
                        Expira: {format(new Date(invitation.expiresAt), "d 'de' MMMM, yyyy", { locale: es })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between sm:justify-end gap-2 sm:gap-3 pl-11 sm:pl-0">
                    <Badge variant={getRoleBadgeVariant(invitation.role)} className="gap-1 text-xs">
                      {getRoleIcon(invitation.role)}
                      {ROLE_LABELS[invitation.role as Role] || invitation.role}
                    </Badge>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 sm:h-9 sm:w-9"
                        onClick={() => regeneratePasswordMutation.mutate(invitation.id)}
                        disabled={regeneratePasswordMutation.isPending}
                        title="Regenerar contraseña"
                        data-testid={`button-regenerate-password-${invitation.id}`}
                      >
                        {regeneratePasswordMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 sm:h-9 sm:w-9 text-destructive hover:text-destructive"
                        onClick={() => setCancellingInvitation(invitation)}
                        data-testid={`button-cancel-invitation-${invitation.id}`}
                      >
                        <X className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {planLimits && !planLimits.isTeamPlan && atMemberLimit && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="py-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="p-3 rounded-full bg-primary/10">
                <Users className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-base mb-1">¿Necesitás más miembros?</h3>
                <p className="text-sm text-muted-foreground">
                  Ya usaste tu invitación disponible. Para agregar más personas, podés cambiar a un plan empresarial con más capacidad.
                </p>
              </div>
              <a 
                href="/subscription" 
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary hover:bg-primary/90 rounded-lg transition-colors whitespace-nowrap"
                data-testid="button-upgrade-team-banner"
              >
                Ver planes
              </a>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Miembros ({members.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {members.map((member) => (
              <div
                key={member.id}
                className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 py-3 sm:py-4 first:pt-0 last:pb-0"
                data-testid={`member-row-${member.id}`}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-primary-foreground font-medium text-sm sm:text-base flex-shrink-0">
                    {member.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm sm:text-base truncate">{member.name}</p>
                    <p className="text-xs sm:text-sm text-muted-foreground truncate">{member.email}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between sm:justify-end gap-2 sm:gap-3 pl-11 sm:pl-0">
                  <Badge variant={getRoleBadgeVariant(member.role)} className="gap-1 text-xs">
                    {getRoleIcon(member.role)}
                    {ROLE_LABELS[member.role as Role] || member.role}
                  </Badge>
                  {canManageTeam && member.userId !== currentMembership?.userId && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 sm:h-9 sm:w-9"
                        onClick={() => setEditingMember(member)}
                        data-testid={`button-edit-member-${member.id}`}
                      >
                        <Shield className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 sm:h-9 sm:w-9 text-destructive hover:text-destructive"
                        onClick={() => setDeletingMember(member)}
                        data-testid={`button-delete-member-${member.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {members.length === 0 && (
              <div className="py-8 text-center text-muted-foreground">
                No hay miembros en el equipo
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!editingMember} onOpenChange={() => setEditingMember(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambiar rol</DialogTitle>
            <DialogDescription>
              Modifica el rol de {editingMember?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Nuevo rol</Label>
              <Select
                value={editingMember?.role || "operator"}
                onValueChange={(role) => setEditingMember(prev => prev ? { ...prev, role } : null)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      <div className="flex items-center gap-2">
                        {getRoleIcon(role)}
                        <span>{ROLE_LABELS[role]}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editingMember && (
                <p className="text-sm text-muted-foreground">
                  {ROLE_DESCRIPTIONS[editingMember.role as Role]}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMember(null)}>
              Cancelar
            </Button>
            <Button
              onClick={() => editingMember && updateRoleMutation.mutate({ id: editingMember.id, role: editingMember.role })}
              disabled={updateRoleMutation.isPending}
            >
              {updateRoleMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deletingMember} onOpenChange={() => setDeletingMember(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar miembro</DialogTitle>
            <DialogDescription>
              Estas seguro de eliminar a {deletingMember?.name} del equipo? Esta accion no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingMember(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => deletingMember && deleteMemberMutation.mutate(deletingMember.id)}
              disabled={deleteMemberMutation.isPending}
            >
              {deleteMemberMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!credentials} onOpenChange={() => setCredentials(null)}>
        <DialogContent data-testid="credentials-modal">
          <DialogHeader>
            <DialogTitle>Credenciales de Acceso</DialogTitle>
            <DialogDescription>
              Comparte estas credenciales con el usuario invitado. La contraseña es temporal y deberá cambiarla en el primer acceso.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Email</Label>
              <div className="p-3 bg-muted rounded-md font-mono text-sm" data-testid="credentials-email">
                {credentials?.email}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Contraseña Temporal</Label>
              <div className="p-3 bg-muted rounded-md font-mono text-sm" data-testid="credentials-password">
                {credentials?.temporaryPassword}
              </div>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={copyCredentialsToClipboard}
              className="w-full sm:w-auto"
              data-testid="button-copy-credentials"
            >
              <Copy className="h-4 w-4 mr-2" />
              Copiar al portapapeles
            </Button>
            <Button onClick={() => setCredentials(null)} className="w-full sm:w-auto" data-testid="button-close-credentials">
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancellingInvitation} onOpenChange={() => setCancellingInvitation(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar invitación</DialogTitle>
            <DialogDescription>
              ¿Estás seguro de cancelar la invitación para {cancellingInvitation?.email}? Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancellingInvitation(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancellingInvitation && cancelInvitationMutation.mutate(cancellingInvitation.id)}
              disabled={cancelInvitationMutation.isPending}
              data-testid="button-confirm-cancel-invitation"
            >
              {cancelInvitationMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Eliminar Invitación
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </>
  );
}

function formatPermission(perm: Permission): string {
  const map: Record<Permission, string> = {
    "transactions:create": "Crear movimientos",
    "transactions:edit": "Editar movimientos",
    "transactions:delete": "Eliminar movimientos",
    "accounts:create": "Crear cuentas",
    "accounts:edit": "Editar cuentas",
    "accounts:delete": "Eliminar cuentas",
    "users:manage": "Gestionar usuarios",
    "organization:settings": "Configuracion",
    "reports:export": "Exportar reportes",
    "crm:read": "Ver CRM",
    "crm:write": "Gestionar CRM",
    "workorders:read": "Ver órdenes de trabajo",
    "workorders:write": "Gestionar órdenes de trabajo",
  };
  return map[perm] || perm;
}
