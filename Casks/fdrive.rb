cask "fdrive" do
  version "0.4.0"
  sha256 "c6b2b57d232946014482bca6eca69c50f9bbb5df1a7be06c19e4139b12c87a15"

  # Private releases use GitHub's authenticated asset endpoint. The ordinary URL
  # works without a token after the source repository becomes public.
  if ENV["HOMEBREW_GITHUB_API_TOKEN"].to_s.empty?
    url "https://github.com/fredrikburmester/fdrive/releases/download/macos-v#{version}/fdrive-#{version}-arm64.dmg"
  else
    url "https://api.github.com/repos/fredrikburmester/fdrive/releases/assets/573140936",
        header: ["Accept: application/octet-stream",
                 "Authorization: Bearer #{ENV.fetch("HOMEBREW_GITHUB_API_TOKEN")}"]
  end
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
