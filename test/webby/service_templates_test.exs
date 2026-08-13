defmodule Webby.ServiceTemplatesTest do
  use ExUnit.Case, async: true

  @systemd "rel/overlays/lib/systemd/webby.service"
  @launchd "rel/overlays/lib/launchd/ai.dinglebear.webby.plist"

  test "systemd template is a loopback-only per-user service" do
    unit = File.read!(@systemd)

    assert unit =~ "ExecStart=%h/.local/lib/webby/bin/webby start"
    assert unit =~ "Restart=on-failure"
    assert unit =~ "UMask=0077"
    assert unit =~ "WEBBY_PORT=6477"
    refute unit =~ "User=root"
    refute unit =~ "0.0.0.0"
    refute String.downcase(unit) =~ "labby"
  end

  test "launchd template starts Webby at login without widening its listener" do
    plist = File.read!(@launchd)

    assert plist =~ "<string>ai.dinglebear.webby</string>"
    assert plist =~ "<key>RunAtLoad</key>"
    assert plist =~ "<key>KeepAlive</key>"
    assert plist =~ "<key>SuccessfulExit</key>"
    refute plist =~ "0.0.0.0"
    refute String.downcase(plist) =~ "labby"
  end
end
