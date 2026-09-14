// SPDX-License-Identifier: AGPL-3.0-only
package httpd

import (
	"net/http"
	"slices"

	"github.com/drakkan/sftpgo/v2/internal/common"
	"github.com/drakkan/sftpgo/v2/internal/dataprovider"
	"github.com/drakkan/sftpgo/v2/internal/fdrivelease"
	"github.com/go-chi/render"
	"github.com/sftpgo/sdk"
)

func fdriveLeaseUser(user *dataprovider.User) bool {
	return fdrivelease.Allowed(user.Username) && user.CheckLoginConditions() == nil &&
		!slices.Contains(user.Filters.WebClient, sdk.WebClientWriteDisabled) &&
		user.FsConfig.Provider == sdk.LocalFilesystemProvider && len(user.VirtualFolders) == 0
}

func handleFdriveLease(w http.ResponseWriter, r *http.Request) {
	if !fdrivelease.Enabled() {
		http.NotFound(w, r)
		return
	}
	connection, err := getUserConnection(w, r)
	if err != nil {
		return
	}
	defer connection.CloseFS() //nolint:errcheck
	defer common.Connections.Remove(connection.ID)
	if !fdriveLeaseUser(&connection.User) {
		sendAPIResponse(w, r, nil, "This user is not qualified for native write leases", http.StatusForbidden)
		return
	}
	token := r.Header.Get(fdrivelease.Header)
	switch r.Method {
	case http.MethodPost:
		if token != "" {
			sendAPIResponse(w, r, nil, "Acquire requires no existing lease", http.StatusBadRequest)
			return
		}
		token, err = fdrivelease.Global.Acquire(connection.User.Username)
	case http.MethodPatch:
		err = fdrivelease.Global.Renew(token, connection.User.Username)
	case http.MethodDelete:
		err = fdrivelease.Global.Release(token, connection.User.Username)
	}
	if err != nil {
		sendAPIResponse(w, r, nil, "Storage is busy or the lease expired", http.StatusConflict)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodDelete {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	render.JSON(w, r, map[string]any{"protocol": fdrivelease.Protocol, "token": token, "timeoutSeconds": int(fdrivelease.Duration.Seconds())})
}
