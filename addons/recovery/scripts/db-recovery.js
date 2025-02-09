var SQLDB = "sqldb",
    AUTH_ERROR_CODE = 701,
    ERROR_INIT_ACTION = 97,
    UNABLE_RESTORE_CODE = 98,
    FAILED_CLUSTER_CODE = 99,
    RESTORE_SUCCESS = 201,
    envName = "${env.name}",
    exec = getParam('exec', ''),
    init = getParam('init', ''),
    failedNodes = [],
    isMasterFailed = false,
    GALERA = "galera",
    PRIMARY = "primary",
    SECONDARY = "secondary",
    FAILED = "failed",
    FAILED_UPPER_CASE = "FAILED",
    SUCCESS = "success",
    WARNING = "warning",
    MASTER = "master",
    SLAVE = "slave",
    ROOT = "root",
    DOWN = "down",
    UP = "up",
    OK = "ok",
    isRestore = false,
    envInfo,
    nodeGroups,
    donorIps = {},
    primaryDonorIp = "",
    scenario = "",
    scheme,
    item,
    resp;

if (init) {
    resp = execRecovery(init);
    if (resp.result != 0) return resp;

    resp = parseOut(resp.responses);
    if (resp.result != 0) return resp;
}

if (!exec) isRestore = true;
exec = exec || " --diagnostic";

resp = getNodeGroups();
if (resp.result != 0) return resp;

nodeGroups = resp.nodeGroups;

for (var i = 0, n = nodeGroups.length; i < n; i++) {
    if (nodeGroups[i].name == SQLDB && nodeGroups[i].cluster && nodeGroups[i].cluster.enabled) {
        if (nodeGroups[i].cluster.settings) {
            scheme = nodeGroups[i].cluster.settings.scheme;
            if (scheme == SLAVE) scheme = SECONDARY;
            if (scheme == MASTER) scheme = PRIMARY;
            break;
        }
    }
}
api.marketplace.console.WriteLog("start-> ");
api.marketplace.console.WriteLog("isRestore-> " + isRestore);
api.marketplace.console.WriteLog("scheme-> " + scheme);
resp = execRecovery();
if (resp.result != 0) return resp;

resp = parseOut(resp.responses, true);

if (isRestore) {
    if (resp.result == AUTH_ERROR_CODE) return resp;
    if (resp.result == UNABLE_RESTORE_CODE || resp.result == FAILED_CLUSTER_CODE) return resp;

    if (isMasterFailed) {
        scenario = " --scenario restore_primary_from_secondary";
        resp = getSlavesOnly(scenario);
        if (resp.result != 0) return resp;

        failedNodes = resp.nodes;
    }

    api.marketplace.console.WriteLog("failedNodes-> " + failedNodes);
    if (!failedNodes.length) {
        return {
            result: !isRestore ? 200 : RESTORE_SUCCESS,
            type: SUCCESS
        };
    }

    if (!donorIps[scheme]) { //!scenario ||
        return {
            result: UNABLE_RESTORE_CODE,
            type: SUCCESS
        }
    }

    for (var k = 0, l = failedNodes.length; k < l; k++) {
        resp = getNodeIdByIp(failedNodes[k].address);
        if (resp.result != 0) return resp;

        resp = execRecovery(failedNodes[k].scenario, donorIps[scheme], resp.nodeid);
        if (resp.result != 0) return resp;

        resp = parseOut(resp.responses, false);
        if (resp.result == UNABLE_RESTORE_CODE || resp.result == FAILED_CLUSTER_CODE) return resp;
    }

} else {
    return resp;
}

function parseOut(data, restoreMaster) {
    var resp,
        nodeid,
        statusesUp = false,
        clusterFailed = false,
        primaryMasterAddress = "",
        primaryEnabledService = "",
        failedPrimary = [];

    if (scheme == SECONDARY && restoreMaster) {
        failedNodes = [];
        failedPrimary = [];
        donorIps = {};
    }

    if (data.length) {
        for (var i = 0, n = data.length; i < n; i++) {
            nodeid = data[i].nodeid;
            if (data[i] && data[i].out) {
                item = data[i].out;

                api.marketplace.console.WriteLog("item->" + item);
                item = JSON.parse(item);

                if (item.result == AUTH_ERROR_CODE) {
                    return {
                        type: WARNING,
                        message: item.error,
                        result: AUTH_ERROR_CODE
                    };
                }

                if (!item.node_type) {
                    clusterFailed = true;

                    if (!isRestore && item.address) {
                        resp = setFailedDisplayNode(item.address);
                        if (resp.result != 0) return resp;
                        continue;
                    }
                }

                if (item.result == 0) {
                    switch (String(scheme)) {
                        case GALERA:
                            if ((item.service_status == UP || item.status == OK) && item.galera_myisam != OK) {
                                return {
                                    type: WARNING,
                                    message: "There are MyISAM tables in the Galera Cluster. These tables should be converted in InnoDB type"
                                }
                            }

                            if (item.service_status == DOWN || item.status == FAILED) {
                                scenario = " --scenario restore_galera";
                                if (!donorIps[scheme]) {
                                    donorIps[GALERA] = GALERA;
                                }

                                failedNodes.push({
                                    address: item.address,
                                    scenario: scenario
                                });

                                if (!isRestore && item.address) {
                                    resp = setFailedDisplayNode(item.address);
                                    if (resp.result != 0) return resp;
                                }
                            }

                            // if (!isRestore && failedNodes.length) {
                            //     return {
                            //         result: FAILED_CLUSTER_CODE,
                            //         type: SUCCESS
                            //     };
                            // }

                            if (item.service_status == UP && item.status == OK && item.address) {
                                resp = setFailedDisplayNode(item.address, true);
                                if (resp.result != 0) return resp;
                            }
                            break;

                        case PRIMARY:
                            if (item.service_status == DOWN || item.status == FAILED) {
                                if (item.node_type == SECONDARY) {
                                    scenario = " --scenario restore_secondary_from_primary";
                                } else {
                                    scenario = " --scenario restore_primary_from_primary";
                                }

                                if (item.service_status == UP) {
                                    if (!donorIps[scheme]) {
                                        donorIps[PRIMARY] = item.address;
                                    }

                                    if (item.address == "${nodes.sqldb.master.address}") {
                                        primaryMasterAddress = item.address;
                                    }
                                }

                                if (!isRestore && item.address) {
                                    resp = setFailedDisplayNode(item.address);
                                    if (resp.result != 0) return resp;
                                }

                                if (!donorIps[scheme] && item.service_status == UP) {
                                    donorIps[PRIMARY] = item.address;
                                }

                                if (item.status == FAILED) {
                                    if (item.node_type == PRIMARY) {
                                        failedPrimary.push({
                                            address: item.address,
                                            scenario: scenario
                                        });
                                        restoreMaster = true;
                                    } else {
                                        failedNodes.push({
                                            address: item.address,
                                            scenario: scenario
                                        });
                                    }
                                }
                                // if (!isRestore) {
                                //     return {
                                //         result: FAILED_CLUSTER_CODE,
                                //         type: SUCCESS
                                //     };
                                // }
                                restoreMaster = true;
                            }

                            if (item.service_status == UP && item.status == OK) {
                                if (item.node_type == PRIMARY) {
                                    primaryMasterAddress = item.address;
                                    donorIps[PRIMARY] = item.address;
                                }

                                if (item.address) {
                                    resp = setFailedDisplayNode(item.address, true);
                                    if (resp.result != 0) return resp;
                                }
                            }

                            break;

                        case SECONDARY:
                            isMasterFailed = false;
                            if (item.service_status == DOWN || item.status == FAILED) {

                                if (!isRestore && item.address) {
                                    resp = setFailedDisplayNode(item.address);
                                    if (resp.result != 0) return resp;
                                }

                                // if (!isRestore) {
                                //     return {
                                //         result: FAILED_CLUSTER_CODE,
                                //         type: SUCCESS
                                //     };
                                // }

                                if (item.service_status == DOWN && item.status == FAILED) {
                                    if (item.node_type == PRIMARY) {
                                        scenario = " --scenario restore_primary_from_secondary";
                                        failedPrimary.push({
                                            address: item.address,
                                            scenario: scenario
                                        });
                                        isMasterFailed = true;
                                    } else {
                                        scenario = " --scenario restore_secondary_from_primary";
                                        failedNodes.push({
                                            address: item.address,
                                            scenario: scenario
                                        });
                                    }
                                } else if (item.node_type == PRIMARY) {
                                    scenario = " --scenario restore_primary_from_secondary";
                                    failedPrimary.push({
                                        address: item.address,
                                        scenario: scenario
                                    });
                                    isMasterFailed = true;
                                } else if (item.status == FAILED) {
                                    scenario = " --scenario restore_secondary_from_primary";
                                    failedNodes.push({
                                        address: item.address,
                                        scenario: scenario
                                    });
                                }
                            }

                            if (item.node_type == PRIMARY) {
                                if (item.service_status == UP && item.status == OK) {
                                    primaryDonorIp = item.address;
                                }
                            }

                            if (item.service_status == UP && item.status == OK) {
                                donorIps[SECONDARY] = item.address;
                                statusesUp = true;

                                if (item.address) {
                                    resp = setFailedDisplayNode(item.address, true);
                                    if (resp.result != 0) return resp;
                                }
                            } else if (!statusesUp && item.node_type == SECONDARY && item.service_status == UP) {
                                donorIps[SECONDARY] = item.address;
                            }

                            if (primaryDonorIp) { //!donorIps[scheme]
                                donorIps[scheme] = primaryDonorIp;
                                continue;
                            }
                            break;
                    }
                } else {
                    if (init && item.result == FAILED_CLUSTER_CODE) {
                        return {
                            result: ERROR_INIT_ACTION,
                            message: item.error,
                            type: WARNING
                        }
                    }

                    return {
                        result: isRestore ? UNABLE_RESTORE_CODE : FAILED_CLUSTER_CODE,
                        type: SUCCESS
                    };
                }
            }
        }

        if (!isRestore && (failedNodes.length || failedPrimary.length)) {
            return {
                result: FAILED_CLUSTER_CODE,
                type: SUCCESS
            };
        }

        if (!failedNodes.length && failedPrimary.length) {
            failedNodes = failedPrimary;
        }

        if ((!scenario || !donorIps[scheme]) && failedNodes.length) {
            return {
                result: UNABLE_RESTORE_CODE,
                type: SUCCESS
            }
        }

        api.marketplace.console.WriteLog("failedPrimary-> "+ failedPrimary);
        api.marketplace.console.WriteLog("failedNodes-> "+ failedNodes);
        api.marketplace.console.WriteLog("primaryMasterAddress-> "+ primaryMasterAddress);
        api.marketplace.console.WriteLog("donorIps-> "+ donorIps);
        if (isRestore && restoreMaster && failedPrimary.length) { //restoreAll
            if (failedPrimary.length > 1) {
                primaryEnabledService = primaryMasterAddress || donorIps[scheme];
                i = failedPrimary.length;

                while (i--) {
                    if (failedPrimary[i].address != primaryEnabledService) {
                        resp = getNodeIdByIp(failedPrimary[i].address);
                        if (resp.result != 0) return resp;

                        resp = execRecovery(failedPrimary[i].scenario, primaryEnabledService, resp.nodeid);
                        if (resp.result != 0) return resp;

                        resp = parseOut(resp.responses);
                        if (resp.result == UNABLE_RESTORE_CODE || resp.result == FAILED_CLUSTER_CODE) return resp;

                        if (resp.result == RESTORE_SUCCESS) {
                            failedPrimary.splice(i, 1);
                        }
                    }
                }
            }

            if (failedPrimary[0]) {
                resp = getNodeIdByIp(failedPrimary[0].address);
                if (resp.result != 0) return resp;

                resp = execRecovery(failedPrimary[0].scenario, donorIps[scheme], resp.nodeid);
                if (resp.result != 0) return resp;
                resp = parseOut(resp.responses);
                if (resp.result == UNABLE_RESTORE_CODE || resp.result == FAILED_CLUSTER_CODE) return resp;

                if (failedNodes.length) {
                    i = failedNodes.length;
                    while (i--) {
                        if (failedNodes[i].address == failedPrimary[0].address) {
                            failedNodes.splice(i, 1);
                            break;
                        }
                    }
                }
            }
            failedPrimary = [];

            if (primaryDonorIp) {
                donorIps[scheme] = primaryDonorIp;
            }
        }

        if (clusterFailed) {
            return {
                result: isRestore ? UNABLE_RESTORE_CODE : FAILED_CLUSTER_CODE,
                type: SUCCESS
            };
        }

        return {
            result: !isRestore ? 200 : 201,
            type: SUCCESS
        };
    }
}

return {
    result: !isRestore ? 200 : 201,
    type: SUCCESS
};

function setFailedDisplayNode(address, removeLabelFailed) {
    var REGEXP = new RegExp('\\b - ' + FAILED + '\\b', 'gi'),
        displayName,
        resp,
        node;

    removeLabelFailed = !!removeLabelFailed;

    resp = getNodeIdByIp(address);
    if (resp.result != 0) return resp;

    resp = getNodeInfoById(resp.nodeid);
    if (resp.result != 0) return resp;
    node = resp.node;

    if (!isRestore && node.displayName.indexOf(FAILED_UPPER_CASE) != -1) return { result: 0 }

    displayName = removeLabelFailed ? node.displayName.replace(REGEXP, "") : (node.displayName + " - " + FAILED_UPPER_CASE);
    return api.env.control.SetNodeDisplayName(envName, session, node.id, displayName);
}

function getNodeInfoById(id) {
    var envInfo,
        nodes,
        node;

    envInfo = getEnvInfo();
    if (envInfo.result != 0) return envInfo;

    nodes = envInfo.nodes;

    for (var i = 0, n = nodes.length; i < n; i++) {
        if (nodes[i].id == id) {
            node = nodes[i];
            break;
        }
    }

    return {
        result: 0,
        node: node
    }
}

function getNodeIdByIp(address) {
    var envInfo,
        nodes,
        id = "";

    envInfo = getEnvInfo();
    if (envInfo.result != 0) return envInfo;

    nodes = envInfo.nodes;

    for (var i = 0, n = nodes.length; i < n; i++) {
        if (nodes[i].address == address) {
            id = nodes[i].id;
            break;
        }
    }

    return {
        result: 0,
        nodeid : id
    }
}

function execRecovery(scenario, donor, nodeid) {
    var action = "";

    if (scenario && donor) {
        action = scenario + " --donor-ip " +  donor;
    } else {
        if (scenario && !donor) {
            action = scenario;
        } else {
            action = exec;
        }
    }

    api.marketplace.console.WriteLog("curl --silent https://raw.githubusercontent.com/jelastic-jps/mysql-cluster/master/addons/recovery/scripts/db-recovery.sh > /tmp/db-recovery.sh && bash /tmp/db-recovery.sh " + action);
    return cmd({
        command: "curl --silent https://raw.githubusercontent.com/jelastic-jps/mysql-cluster/master/addons/recovery/scripts/db-recovery.sh > /tmp/db-recovery.sh && bash /tmp/db-recovery.sh " + action,
        nodeid: nodeid || ""
    });
}

function getEnvInfo() {
    var resp;

    if (!envInfo) {
        envInfo = api.env.control.GetEnvInfo(envName, session);
    }

    return envInfo;
}

function getSlavesOnly() {
    var resp,
        slaves = [];

    resp = getSQLNodes();
    if (resp.result != 0) return resp;

    for (var i = 0, n = resp.nodes.length; i < n; i++) {
        if (resp.nodes[i].address != primaryDonorIp) {
            slaves.push({
                address: resp.nodes[i].address,
                scenario: scenario
            });
        }
    }

    return {
        result: 0,
        nodes: slaves
    }
}

function getSQLNodes() {
    var resp,
        sqlNodes = [],
        nodes;

    resp = getEnvInfo();
    if (resp.result != 0) return resp;
    nodes = resp.nodes;

    for (var i = 0, n = nodes.length; i < n; i++) {
        if (nodes[i].nodeGroup == SQLDB) {
            sqlNodes.push(nodes[i]);
        }
    }

    return {
        result: 0,
        nodes: sqlNodes
    }
}

function getNodeGroups() {
    var envInfo;

    envInfo = getEnvInfo();
    if (envInfo.result != 0) return envInfo;

    return {
        result: 0,
        nodeGroups: envInfo.nodeGroups
    }
}

function cmd(values) {
    var resp;

    values = values || {};

    if (values.nodeid) {
        api.marketplace.console.WriteLog("ExecCmdById->" + values.nodeid);
        resp = api.env.control.ExecCmdById(envName, session, values.nodeid, toJSON([{ command: values.command }]), true, ROOT);
    } else {
        resp = api.env.control.ExecCmdByGroup(envName, session, values.nodeGroup || SQLDB, toJSON([{ command: values.command }]), true, false, ROOT);
    }

    return resp;
}
