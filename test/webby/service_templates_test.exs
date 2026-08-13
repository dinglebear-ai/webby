defmodule Webby.ServiceTemplatesTest do
  use ExUnit.Case, async: true

  @systemd "rel/overlays/lib/systemd/webby.service"
  @launchd "rel/overlays/lib/launchd/ai.dinglebear.webby.plist"

  test "systemd template is a loopback-only per-user service" do
    unit = File.read!(@systemd)

    assert unit =~ "ExecStart=%h/.local/lib/webby/bin/webby start"
    assert unit =~ "Restart=on-failure"

    assert unit =~
             "[Unit]\nDescription=Webby local WebMCP bridge\nAfter=network.target\nStartLimitIntervalSec=30s"

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
    assert plist =~ "<string>/bin/sh</string>"
    assert plist =~ ~s(cd "$HOME/Library/Application Support/Webby")
    assert plist =~ "exec ./bin/webby start"
    assert plist =~ "$HOME/Library/Logs/Webby/webby.log"
    assert plist =~ "$HOME/Library/Logs/Webby/webby-error.log"
    assert plist =~ "<key>Umask</key>\n  <integer>63</integer>"
    refute plist =~ "<string>${HOME}"
    refute plist =~ "0.0.0.0"
    refute String.downcase(plist) =~ "labby"
  end
end
