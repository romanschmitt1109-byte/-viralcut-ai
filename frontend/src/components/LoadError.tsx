import { FolderX } from "lucide-react";
import { Link } from "react-router-dom";
import { DEMO } from "../lib/demo";
import { Empty, ErrorBox } from "./ui";

/** Erreur de chargement d'une page de projet / clip, avec une issue claire. */
export default function LoadError({ message }: { message: string }) {
  if (!/introuvable/i.test(message)) return <ErrorBox>{message}</ErrorBox>;
  return (
    <Empty icon={<FolderX className="h-5 w-5" />} title={message}>
      <p>
        {DEMO
          ? "Ce projet n'est plus enregistré sur cet appareil (il a peut-être été créé avant l'ajout de la sauvegarde locale, ou les données du site ont été effacées)."
          : "Il a peut-être été supprimé."}
      </p>
      <div className="mt-4 flex justify-center gap-4">
        <Link to="/app" className="text-violet-300 hover:text-violet-200">Tableau de bord</Link>
        <Link to="/app/import" className="text-violet-300 hover:text-violet-200">Importer une vidéo</Link>
      </div>
    </Empty>
  );
}
