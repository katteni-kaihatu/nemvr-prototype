defmodule ProtoServer.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Finch, name: ProtoServer.Finch},
      {Task.Supervisor, name: ProtoServer.TaskSupervisor},
      {Registry, keys: :unique, name: ProtoServer.Space.Registry},
      ProtoServer.Ipfs,
      ProtoServer.Content,
      {ProtoServer.Space.Store, session_id: "main", seed: true},
      ProtoServer.Queue,
      ProtoServer.Place,
      ProtoServer.HttpServer
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: ProtoServer.Supervisor)
  end
end
