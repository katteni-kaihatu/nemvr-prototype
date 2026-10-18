import { Lobby } from "./Lobby";
import { useNet } from "./net/connection";
import { World } from "./world/World";

export function App() {
  const status = useNet((s) => s.status);
  return status === "connected" ? <World /> : <Lobby />;
}
