import { useEffect, useState } from "react";
import { api } from "./api";
type Connection = { catalogMusic: boolean; username: string; expiresAt: number | null };
export default function MetaConnection() {
  const [connection, setConnection] = useState<Connection>();
  useEffect(() => { void api<Connection>("/api/admin/meta-connection").then(setConnection).catch(() => undefined); }, []);
  if (!connection?.catalogMusic) return null;
  return <section className="form-card meta-connection"><h2>Instagram music connected</h2><p>Reel music is available{connection.username ? ` for @${connection.username}` : ""}.</p>{connection.expiresAt && <p className="field-hint">Connection expires {new Date(connection.expiresAt * 1000).toLocaleDateString()}.</p>}</section>;
}
