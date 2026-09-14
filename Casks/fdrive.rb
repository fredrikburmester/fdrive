cask "fdrive" do
  version "0.1.0"
  sha256 "3b579cf027dc054073b2492b6c0484a8f17864b8f684558b4bcbacd8a1741f52"

  # Private releases use GitHub's authenticated asset endpoint. The ordinary URL
  # works without a token after the source repository becomes public.
  if ENV["HOMEBREW_GITHUB_API_TOKEN"].to_s.empty?
    url "https://github.com/fredrikburmester/fdrive-web/releases/download/macos-v#{version}/fdrive-#{version}-arm64.dmg"
  else
    url "https://api.github.com/repos/fredrikburmester/fdrive-web/releases/assets/564160815",
        header: ["Accept: application/octet-stream",
                 "Authorization: Bearer #{ENV.fetch("HOMEBREW_GITHUB_API_TOKEN")}"]
  end
  name "FDrive"
  desc "Browse remote storage in Finder with downloads on demand"
  homepage "https://github.com/fredrikburmester/fdrive-web"

  depends_on arch: :arm64
  depends_on macos: :tahoe

  app "FDrive.app"

  caveats <<~EOS
    Connect using your fdrive HTTPS web address, then enable the Finder location.
    Quit FDrive before upgrading. Disconnect locations in FDrive before uninstalling.
  EOS
end
