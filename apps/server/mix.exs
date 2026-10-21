defmodule ProtoServer.MixProject do
  use Mix.Project

  def project do
    [
      app: :proto_server,
      version: "0.1.0",
      elixir: "~> 1.14",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      releases: [
        proto_server: [
          include_erts: true,
          extended_start_script: true
        ]
      ]
    ]
  end

  def application do
    [
      extra_applications: [:logger, :crypto, :ssl, :inets],
      mod: {ProtoServer.Application, []}
    ]
  end

  defp deps do
    [
      {:cowboy, "~> 2.12"},
      {:jason, "~> 1.4"},
      {:finch, "~> 0.19"}
    ]
  end
end
