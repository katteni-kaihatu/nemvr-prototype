ExUnit.start()

# The test suite starts these children with its own options and names (for
# example `Room` with seeding disabled), so stop the application-owned instances
# first. `HttpServer` and `Finch` keep running for integration tests.
if Process.whereis(ProtoServer.Supervisor) do
  for child <- [
        ProtoServer.Ipfs,
        ProtoServer.Room,
        ProtoServer.Content,
        ProtoServer.Queue,
        ProtoServer.Place
      ] do
    case Supervisor.terminate_child(ProtoServer.Supervisor, child) do
      :ok -> :ok
      {:error, :not_found} -> :ok
    end
  end
end
