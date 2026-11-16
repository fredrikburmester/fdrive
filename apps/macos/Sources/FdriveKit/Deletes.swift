import FileProvider
import Foundation

/// How a permanent delete Finder asked for ended.
public enum DeleteOutcome: Sendable, Equatable {
    /// Gone for good: deleted from fdrive's Trash, or never known here.
    case deleted
    /// Kept, as it now stands: in fdrive's Trash after a move there, or where it was when
    /// the delete was refused.
    case kept(CatalogItem)
}

extension WriteCoordinator {
    /// Finder's permanent delete (`deleteItem`): Empty Trash, Delete Immediately, or an app
    /// removing a file. Nothing anyone can still want is destroyed. A whole item in Trash is
    /// deleted for good, as Empty Trash does on the web; anything else moves to fdrive's
    /// Trash and stays there for Days in Trash. A delete that would take a pending write
    /// along, that the server refuses, or that cannot reach the server keeps the item, and
    /// leaves nothing pending. It never throws: File Provider retries a failed delete forever.
    public func delete(_ id: String, base: WriteVersion) async -> DeleteOutcome {
        guard let item = try? await catalog.item(id) else { return .deleted }
        guard id != "root", id != "trash" else { return .kept(item) }
        if item.entry.trashed == true {
            // Only a whole Trash item is deleted for good, never something inside one.
            guard item.parentId == "trash", let handle = item.entry.id,
                  (try? await catalog.hasPendingWrite(within: item)) == false else { return .kept(item) }
            do { try await client.purge(handle) } catch { return .kept(item) }
            // Gone on the server either way; the next Trash listing finishes what this cannot.
            try? await catalog.purged(id)
            return .deleted
        }
        do {
            return .kept(try await perform(route: "moves", localId: id, templateKey: id, parentId: "trash",
                                           name: item.entry.name, base: base, contents: nil,
                                           progress: Progress(totalUnitCount: -1)))
        } catch {
            await abandonTrashMove(id)
            return .kept((try? await catalog.item(id)) ?? item)
        }
    }

    /// macOS puts a refused delete's item back and never asks again, so no move to Trash it
    /// started may stay pending and hold the item's later writes. A move only carries a
    /// handle, so nothing of the person's is in it; a commit the server already began
    /// finishes there, and the next refresh shows where the item went.
    private func abandonTrashMove(_ id: String) async {
        for pending in (try? await catalog.pendingWrites()) ?? []
        where pending.result == nil && pending.localId == id && pending.route == "moves" && pending.request.parentId == "trash" {
            _ = try? await client.cancelWrite(pending.request.operationId)
            try? await catalog.writeCancelled(pending)
        }
    }
}

/// File Provider's answer to a permanent delete: success only for an item gone for good.
/// Every other outcome is the rejection that makes macOS put the item back as `item`
/// presents it, in Trash or where it was, and never retry. File Provider retries any other
/// error, which is how deletes once looped for days.
public func deleteAnswer(_ outcome: DeleteOutcome, item: (CatalogItem) -> NSFileProviderItem) -> Error? {
    switch outcome {
    case .deleted: nil
    case .kept(let kept): NSError.fileProviderErrorForRejectedDeletion(of: item(kept))
    }
}
