cask "fdrive" do
  version "0.4.4"
  sha256 "1b9a695fdc05a2f1617d4395b90f9395aa5d8261c9f5a3eca7915813c3e9e317"

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
