cask "fdrive" do
  version "0.5.4"
  sha256 "640460cb547997e42c23ddccbe3e467c90ff4d9158aa117677af43321610993f"

  url "https://github.com/fredrikburmester/fdrive/releases/download/macos-v#{version}/fdrive-#{version}-arm64.dmg"
  name "FDrive"
  desc "Browse remote storage in Finder with downloads on demand"
  homepage "https://github.com/fredrikburmester/fdrive"

  depends_on arch: :arm64
  depends_on macos: :tahoe

  app "FDrive.app"

  caveats <<~EOS
    FDrive is free to try for 7 days; afterwards it needs a one-time license.
    Connect using your fdrive HTTPS web address, then enable the Finder location.
    Quit FDrive before upgrading. Disconnect locations in FDrive before uninstalling.
  EOS
end
