defmodule ProtoServer.Space.Reader do
  @moduledoc false

  use GenServer

  alias ProtoServer.Protocol
  alias ProtoServer.Space.{Schema, Scope, Store}

  @tick_interval_ms 50

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @spec client(pid(), map()) :: :ok
  def client(reader, message), do: GenServer.cast(reader, {:client, message})

  @impl true
  def init(opts) do
    ws_pid = Keyword.fetch!(opts, :ws_pid)
    session_id = Keyword.fetch!(opts, :session_id)
    scope = Keyword.fetch!(opts, :scope)
    welcome = Keyword.fetch!(opts, :welcome)
    filter = Scope.effective_filter(scope, %{})

    {:ok, subscription_id, version, entities} =
      Store.subscribe(session_id, self(), filter, nil)

    now = System.system_time(:millisecond)

    payload =
      welcome
      |> Map.merge(%{
        "type" => "space_welcome",
        "sessionId" => session_id,
        "templateId" => Map.fetch!(welcome, "templateId"),
        "schemaVersion" => Schema.schema_version(),
        "scope" => Scope.to_map(scope),
        "dimensions" => Schema.dimensions(),
        "subscriptionId" => subscription_id,
        "version" => version,
        "seq" => 0,
        "at" => now,
        "entities" => Enum.map(entities, &Scope.strip_entity(scope, &1)),
        "tickRate" => 20
      })

    send_json(ws_pid, payload)

    subscription = %{
      filter: filter,
      seq: 0,
      version: version,
      at: now,
      buffer: %{},
      timer: nil
    }

    {:ok,
     %{
       ws_pid: ws_pid,
       session_id: session_id,
       scope: scope,
       subscriptions: %{subscription_id => subscription}
     }}
  end

  @impl true
  def handle_cast({:client, %{"type" => "space_query"} = message}, state) do
    request_id = Map.get(message, "requestId")
    filter = Map.get(message, "filter", %{})
    limit = Map.get(message, "limit", 100)

    if is_binary(request_id) and is_map(filter) and is_number(limit) and
         Scope.read_filter_valid?(state.scope, filter) do
      effective = Scope.effective_filter(state.scope, filter)
      {:ok, version, entities} = Store.query(state.session_id, effective, trunc(limit))

      send_json(state.ws_pid, %{
        "type" => "space_query_result",
        "requestId" => request_id,
        "version" => version,
        "entities" => Enum.map(entities, &Scope.strip_entity(state.scope, &1))
      })
    else
      error(state, "invalid_message", "クエリが不正です")
    end

    {:noreply, state}
  end

  def handle_cast({:client, %{"type" => "space_subscribe"} = message}, state) do
    subscription_id = Map.get(message, "subscriptionId")
    filter = Map.get(message, "filter", %{})

    if is_binary(subscription_id) and is_map(filter) and Scope.read_filter_valid?(state.scope, filter) do
      state = remove_subscription(state, subscription_id)
      effective = Scope.effective_filter(state.scope, filter)
      {:ok, store_subscription_id, version, entities} =
        Store.subscribe(state.session_id, self(), effective, subscription_id)

      now = System.system_time(:millisecond)

      send_json(state.ws_pid, %{
        "type" => "space_snapshot",
        "subscriptionId" => store_subscription_id,
        "version" => version,
        "seq" => 0,
        "at" => now,
        "entities" => Enum.map(entities, &Scope.strip_entity(state.scope, &1))
      })

      subscription = %{
        filter: effective,
        seq: 0,
        version: version,
        at: now,
        buffer: %{},
        timer: nil
      }

      {:noreply, %{state | subscriptions: Map.put(state.subscriptions, subscription_id, subscription)}}
    else
      error(state, "invalid_message", "購読が不正です")
      {:noreply, state}
    end
  end

  def handle_cast({:client, %{"type" => "space_unsubscribe"} = message}, state) do
    subscription_id = Map.get(message, "subscriptionId")
    state = if is_binary(subscription_id), do: remove_subscription(state, subscription_id), else: state
    {:noreply, state}
  end

  def handle_cast({:client, _message}, state), do: {:noreply, state}

  @impl true
  def handle_info({:space_event, subscription_id, version, at, changes}, state) do
    case Map.fetch(state.subscriptions, subscription_id) do
      {:ok, subscription} ->
        buffer =
          Enum.reduce(changes, subscription.buffer, fn change, acc ->
            id = change_id(change)
            if id, do: Map.put(acc, id, change), else: acc
          end)

        subscription = %{subscription | buffer: buffer, version: version, at: at}

        subscription =
          if subscription.timer == nil do
            timer = Process.send_after(self(), {:flush, subscription_id}, @tick_interval_ms)
            %{subscription | timer: timer}
          else
            subscription
          end

        {:noreply,
         %{state | subscriptions: Map.put(state.subscriptions, subscription_id, subscription)}}

      :error ->
        {:noreply, state}
    end
  end

  def handle_info({:flush, subscription_id}, state) do
    case Map.fetch(state.subscriptions, subscription_id) do
      {:ok, subscription} ->
        changes =
          subscription.buffer
          |> Map.values()
          |> Enum.map(&strip_change(state.scope, &1))

        subscription = %{subscription | buffer: %{}, timer: nil}

        state = %{state | subscriptions: Map.put(state.subscriptions, subscription_id, subscription)}

        if changes != [] do
          seq = subscription.seq + 1

          send_json(state.ws_pid, %{
            "type" => "space_delta",
            "subscriptionId" => subscription_id,
            "version" => subscription.version,
            "seq" => seq,
            "at" => subscription.at,
            "changes" => changes
          })

          subscription = %{subscription | seq: seq}
          {:noreply, %{state | subscriptions: Map.put(state.subscriptions, subscription_id, subscription)}}
        else
          {:noreply, state}
        end

      :error ->
        {:noreply, state}
    end
  end

  def handle_info(_info, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    Enum.each(state.subscriptions, fn {subscription_id, _subscription} ->
      try do
        Store.unsubscribe(state.session_id, subscription_id)
      rescue
        _ -> :ok
      catch
        _, _ -> :ok
      end
    end)

    :ok
  end

  defp remove_subscription(state, subscription_id) do
    case Map.pop(state.subscriptions, subscription_id) do
      {nil, subscriptions} ->
        %{state | subscriptions: subscriptions}

      {subscription, subscriptions} ->
        if subscription.timer, do: Process.cancel_timer(subscription.timer)

        try do
          Store.unsubscribe(state.session_id, subscription_id)
        rescue
          _ -> :ok
        catch
          _, _ -> :ok
        end

        %{state | subscriptions: subscriptions}
    end
  end

  defp strip_change(scope, %{"op" => "upsert", "entity" => entity} = change) do
    %{change | "entity" => Scope.strip_entity(scope, entity)}
  end

  defp strip_change(_scope, change), do: change

  defp change_id(%{"op" => "upsert", "entity" => %{"id" => id}}), do: id
  defp change_id(%{"op" => "remove", "id" => id}), do: id
  defp change_id(_change), do: nil

  defp send_json(pid, message), do: send(pid, {:proto_send, Protocol.encode(message)})

  defp error(state, code, message) do
    send_json(state.ws_pid, %{"type" => "space_error", "code" => code, "message" => message})
  end
end
