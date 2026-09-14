// SPDX-License-Identifier: AGPL-3.0-only
package httpd

import (
	"net/http"
	"slices"

	"github.com/drakkan/sftpgo/v2/internal/dataprovider"
	"github.com/drakkan/sftpgo/v2/internal/fdrivelease"
	"github.com/drakkan/sftpgo/v2/internal/jwt"
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
	claims, err := jwt.FromContext(r.Context())
	if err != nil || claims.Username == "" {
		sendAPIResponse(w, r, err, "Invalid token claims", http.StatusBadRequest)
		return
	}
	// Lease control must not consume a transfer session: a single-session user
	// needs to renew while an upload occupies that session. Keep fresh account,
	// group, protocol, login-method and address checks without creating a connection.
	user, err := getActiveUser(claims.Username, r)
	if err != nil {
		sendAPIResponse(w, r, nil, "Unable to retrieve your user", getRespStatus(err))
		return
	}
	if !fdriveLeaseUser(&user) {
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
		token, err = fdrivelease.Global.Acquire(user.Username)
	case http.MethodPatch:
		err = fdrivelease.Global.Renew(token, user.Username)
	case http.MethodDelete:
		err = fdrivelease.Global.Release(token, user.Username)
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
