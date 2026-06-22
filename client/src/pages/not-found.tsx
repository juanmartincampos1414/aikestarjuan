import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-[#0A0A0F] to-[#1a1a2e]">
      <Card className="w-full max-w-md mx-4 bg-white/5 border-white/10 backdrop-blur-xl">
        <CardContent className="pt-6 text-center">
          <div className="flex flex-col items-center mb-6">
            <AlertCircle className="h-16 w-16 text-[#FF3366] mb-4" />
            <h1 className="text-3xl font-bold text-white">404</h1>
            <p className="text-lg text-white/70 mt-2">Página no encontrada</p>
          </div>

          <p className="text-sm text-white/50 mb-6">
            La página que buscás no existe o fue movida.
          </p>
          
          <Link href="/">
            <Button className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:opacity-90 text-white">
              <Home className="mr-2 h-4 w-4" />
              Volver al inicio
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
