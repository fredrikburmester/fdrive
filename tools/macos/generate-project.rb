#!/usr/bin/env ruby
# Regeneration only. The generated project is committed; normal builds need no Ruby gems.
gem 'xcodeproj', '1.27.0'
require 'xcodeproj'
require 'fileutils'

root = File.expand_path('../../apps/macos', __dir__)
project_path = File.join(root, 'fdrive.xcodeproj')
project = Xcodeproj::Project.new(project_path)
project.root_object.attributes['LastUpgradeCheck'] = '2660'
package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
package.relative_path = '.'
project.root_object.package_references << package

app = project.new_target(:application, 'fdrive', :osx, '26.0')
app.product_reference.path = 'FDrive.app'
app.product_name = 'FDrive'
extension = project.new_target(:app_extension, 'FdriveFileProvider', :osx, '26.0')
app.add_dependency(extension)
embed = app.new_copy_files_build_phase('Embed App Extensions')
embed.dst_subfolder_spec = '13'
embed.add_file_reference(extension.product_reference).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

[app, extension].each do |target|
  product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  product.product_name = 'FdriveKit'
  product.package = package
  target.package_product_dependencies << product
  build = project.new(Xcodeproj::Project::Object::PBXBuildFile)
  build.product_ref = product
  target.frameworks_build_phase.files << build

  folders = ['Native', target == app ? 'App' : 'Extension']
  folders.each do |folder|
    group = project.main_group.find_subpath(folder, true)
    group.set_source_tree('<group>')
    group.set_path(folder)
    Dir.glob(File.join(root, folder, '*.swift')).sort.each do |path|
      target.add_file_references([group.new_file(File.basename(path))])
    end
  end
  target.build_configurations.each do |configuration|
    configuration.build_settings['PRODUCT_NAME'] = 'FDrive' if target == app
    configuration.build_settings.merge!({
      'SWIFT_VERSION' => '6.0', 'SWIFT_STRICT_CONCURRENCY' => 'complete',
      'MACOSX_DEPLOYMENT_TARGET' => '26.0', 'ARCHS' => 'arm64',
      'CODE_SIGN_STYLE' => 'Automatic', 'ENABLE_HARDENED_RUNTIME' => 'YES',
      'ENABLE_APP_SANDBOX' => 'YES', 'ENABLE_OUTGOING_NETWORK_CONNECTIONS' => 'YES',
      'PRODUCT_BUNDLE_IDENTIFIER' => target == app ? 'se.burmester.fdrive.mac' : 'se.burmester.fdrive.mac.fileprovider',
      'INFOPLIST_FILE' => target == app ? 'App/Info.plist' : 'Extension/Info.plist',
      'CODE_SIGN_ENTITLEMENTS' => 'Native/fdrive.entitlements',
      'PROVISIONING_PROFILE_SPECIFIER' => target == app ? '$(FDRIVE_APP_PROFILE)' : '$(FDRIVE_EXTENSION_PROFILE)',
      'CURRENT_PROJECT_VERSION' => '1', 'MARKETING_VERSION' => '0.1.0',
      'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/../Frameworks', '@executable_path/../../../../Frameworks'],
      'FDRIVE_APP_GROUP' => '$(TeamIdentifierPrefix)se.burmester.fdrive.mac',
      'FDRIVE_KEYCHAIN_GROUP' => '$(AppIdentifierPrefix)se.burmester.fdrive.mac.shared',
      'COMBINE_HIDPI_IMAGES' => 'YES', 'GENERATE_INFOPLIST_FILE' => 'NO',
      'SWIFT_EMIT_LOC_STRINGS' => 'YES', 'SKIP_INSTALL' => target == app ? 'NO' : 'YES'
    })
  end
end
assets = project.main_group['App'].new_file('Assets.xcassets')
app.resources_build_phase.add_file_reference(assets)
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.set_launch_target(app)
scheme.save_as(project_path, 'fdrive', true)
puts project_path
