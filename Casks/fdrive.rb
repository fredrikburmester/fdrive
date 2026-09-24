cask "fdrive" do
  version "0.4.3"
  sha256 "57b4a89556bea6a055f7dbde67975ebdd5b083ae72a26fddda6d80a743f823e5"

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
