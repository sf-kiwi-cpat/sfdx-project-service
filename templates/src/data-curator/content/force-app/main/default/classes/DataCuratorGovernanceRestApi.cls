@RestResource(urlMapping='/data-curator/v1/*')
global with sharing class DataCuratorGovernanceRestApi {
    private static final String API_BASE_PATH = '/services/apexrest/data-curator/v1/';
    private static final String ROUTE_PREFIX = 'data-curator/v1/';
    private static final Integer DEFAULT_STALE_THRESHOLD_DAYS = 180;

    global class UserOptionResponse {
        public String id;
        public String name;
        public String email;
    }

    global class CurrentUserResponse {
        public String id;
        public String name;
        public String username;
        public String roleLabel;
    }

    global class AssetResponse {
        public String id;
        public String name;
        public String apiName;
        public String type;
        public String department;
        public String ownerUserId;
        public String ownerName;
        public String status;
        public Decimal healthScore;
        public String riskLevel;
        public Integer staleDays;
        public String sourceSystem;
    }

    global class TaskResponse {
        public String id;
        public String title;
        public String ownerUserId;
        public String ownerName;
        public String dueDate;
        public String dueLabel;
        public String priority;
        public String status;
        public String taskType;
        public String recommendedAction;
        public String assetId;
        public String assetName;
    }

    global class EventLogResponse {
        public String id;
        public String title;
        public String details;
        public String timeLabel;
        public String badge;
        public String tone;
    }

    global class BootstrapResponse {
        public CurrentUserResponse currentUser;
        public List<UserOptionResponse> users;
        public List<AssetResponse> assets;
        public List<TaskResponse> tasks;
        public List<EventLogResponse> eventLogs;
    }

    global class AssetCreateRequest {
        public String name;
        public String assetType;
        public String department;
        public String ownerUserId;
        public String healthStatus;
    }

    global class TaskCreateRequest {
        public String title;
        public String ownerUserId;
        public String dueDate;
        public String priority;
        public String taskType;
        public String recommendedAction;
        public String metadataAssetId;
    }

    global class AssignOwnerRequest {
        public String assetId;
        public String ownerUserId;
    }

    global class ScanRequest {
        public String departmentFilter;
        public Integer staleThresholdDays;
    }

    global class BulkActionRequest {
        public List<String> assetIds;
        public String action;
        public String ownerUserId;
        public String taskTitle;
        public String taskPriority;
    }

    global class ExportRequest {
        public String format;
        public Integer rowCount;
        public String department;
        public String type;
        public String status;
        public String ownership;
    }

    global class ImportedAssetRequest {
        public String externalKey;
        public String name;
        public String apiName;
        public String assetType;
        public String department;
        public String healthStatus;
        public Decimal healthScore;
        public String riskLevel;
        public String sourceSystem;
        public String stewardshipNotes;
        public Integer staleDays;
        public String lastUsedOn;
        public String lastAttestedOn;
    }

    global class ImportAssetsRequest {
        public List<ImportedAssetRequest> assets;
    }

    global class ImportAssetsResponse {
        public Integer importedCount;
        public Integer createdCount;
        public Integer updatedCount;
    }

    global class ErrorResponse {
        public String error;
        public Object details;

        public ErrorResponse(String errorMessage, Object errorDetails) {
            error = errorMessage;
            details = errorDetails;
        }
    }

    global class DataCuratorGovernanceRestException extends Exception {
        public Integer statusCode;
        public String publicMessage;
    }

    @HttpGet
    global static void handleGet() {
        try {
            String route = getRoute();
            if (route == 'bootstrap') {
                writeJson(200, buildBootstrapResponse());
                return;
            }

            throw buildRestException('Resource not found.', 404);
        } catch (Exception error) {
            handleError(error);
        }
    }

    @HttpPost
    global static void handlePost() {
        try {
            String route = getRoute();
            if (route == 'assets') {
                createAsset((AssetCreateRequest) parseBody(AssetCreateRequest.class));
                writeJson(200, buildBootstrapResponse());
                return;
            }

            if (route == 'tasks') {
                createTask((TaskCreateRequest) parseBody(TaskCreateRequest.class));
                writeJson(200, buildBootstrapResponse());
                return;
            }

            if (route == 'actions/assign-owner') {
                assignOwner((AssignOwnerRequest) parseBody(AssignOwnerRequest.class));
                writeJson(200, buildBootstrapResponse());
                return;
            }

            if (route == 'actions/full-scan') {
                runFullScan();
                writeJson(200, buildBootstrapResponse());
                return;
            }

            if (route == 'actions/stale-review') {
                runStaleReview((ScanRequest) parseBody(ScanRequest.class));
                writeJson(200, buildBootstrapResponse());
                return;
            }

            if (route == 'actions/bulk') {
                runBulkAction((BulkActionRequest) parseBody(BulkActionRequest.class));
                writeJson(200, buildBootstrapResponse());
                return;
            }

            if (route == 'actions/export') {
                recordExport((ExportRequest) parseBody(ExportRequest.class));
                writeJson(200, buildBootstrapResponse());
                return;
            }

            if (route == 'actions/import-assets') {
                writeJson(200, importAssets((ImportAssetsRequest) parseBody(ImportAssetsRequest.class)));
                return;
            }

            throw buildRestException('Resource not found.', 404);
        } catch (Exception error) {
            handleError(error);
        }
    }

    private static BootstrapResponse buildBootstrapResponse() {
        BootstrapResponse response = new BootstrapResponse();
        response.currentUser = queryCurrentUser();
        response.users = queryUsers();
        response.assets = queryAssets();
        response.tasks = queryTasks();
        response.eventLogs = queryEventLogs();
        return response;
    }

    private static CurrentUserResponse queryCurrentUser() {
        User currentUserRecord = [
            SELECT Id, Name, Username, UserRole.Name, Profile.Name
            FROM User
            WHERE Id = :UserInfo.getUserId()
            LIMIT 1
        ];

        CurrentUserResponse responseItem = new CurrentUserResponse();
        responseItem.id = currentUserRecord.Id;
        responseItem.name = currentUserRecord.Name;
        responseItem.username = currentUserRecord.Username;
        responseItem.roleLabel = currentUserRecord.UserRole != null
            ? currentUserRecord.UserRole.Name
            : currentUserRecord.Profile.Name;
        return responseItem;
    }

    private static List<UserOptionResponse> queryUsers() {
        List<UserOptionResponse> results = new List<UserOptionResponse>();
        for (User userRecord : [
            SELECT Id, Name, Email
            FROM User
            WHERE IsActive = true
            ORDER BY Name ASC
            LIMIT 100
        ]) {
            UserOptionResponse responseItem = new UserOptionResponse();
            responseItem.id = userRecord.Id;
            responseItem.name = userRecord.Name;
            responseItem.email = userRecord.Email;
            results.add(responseItem);
        }
        return results;
    }

    private static List<AssetResponse> queryAssets() {
        List<AssetResponse> results = new List<AssetResponse>();
        for (Metadata_Asset__c assetRecord : [
            SELECT
                Id,
                Name,
                API_Name__c,
                Asset_Type__c,
                Department__c,
                Owner_User__c,
                Owner_User__r.Name,
                Health_Status__c,
                Health_Score__c,
                Risk_Level__c,
                Stale_Days__c,
                Source_System__c
            FROM Metadata_Asset__c
            ORDER BY Name ASC
            LIMIT 5000
        ]) {
            AssetResponse responseItem = new AssetResponse();
            responseItem.id = assetRecord.Id;
            responseItem.name = assetRecord.Name;
            responseItem.apiName = assetRecord.API_Name__c;
            responseItem.type = assetRecord.Asset_Type__c;
            responseItem.department = assetRecord.Department__c;
            responseItem.ownerUserId = assetRecord.Owner_User__c;
            responseItem.ownerName = assetRecord.Owner_User__r != null ? assetRecord.Owner_User__r.Name : null;
            responseItem.status = assetRecord.Health_Status__c;
            responseItem.healthScore = assetRecord.Health_Score__c;
            responseItem.riskLevel = assetRecord.Risk_Level__c;
            responseItem.staleDays = assetRecord.Stale_Days__c == null ? null : Integer.valueOf(assetRecord.Stale_Days__c);
            responseItem.sourceSystem = assetRecord.Source_System__c;
            results.add(responseItem);
        }
        return results;
    }

    private static List<TaskResponse> queryTasks() {
        List<TaskResponse> results = new List<TaskResponse>();
        for (Governance_Task__c taskRecord : [
            SELECT
                Id,
                Name,
                Assigned_To__c,
                Assigned_To__r.Name,
                Due_On__c,
                Priority__c,
                Status__c,
                Task_Type__c,
                Recommended_Action__c,
                Metadata_Asset__c,
                Metadata_Asset__r.Name
            FROM Governance_Task__c
            ORDER BY Due_On__c ASC, CreatedDate DESC
            LIMIT 200
        ]) {
            TaskResponse responseItem = new TaskResponse();
            responseItem.id = taskRecord.Id;
            responseItem.title = taskRecord.Name;
            responseItem.ownerUserId = taskRecord.Assigned_To__c;
            responseItem.ownerName = taskRecord.Assigned_To__r != null ? taskRecord.Assigned_To__r.Name : 'Unassigned';
            responseItem.dueDate = taskRecord.Due_On__c == null ? null : String.valueOf(taskRecord.Due_On__c);
            responseItem.dueLabel = taskRecord.Due_On__c == null
                ? 'No due date'
                : taskRecord.Due_On__c.format();
            responseItem.priority = taskRecord.Priority__c;
            responseItem.status = taskRecord.Status__c;
            responseItem.taskType = taskRecord.Task_Type__c;
            responseItem.recommendedAction = taskRecord.Recommended_Action__c;
            responseItem.assetId = taskRecord.Metadata_Asset__c;
            responseItem.assetName = taskRecord.Metadata_Asset__r != null ? taskRecord.Metadata_Asset__r.Name : null;
            results.add(responseItem);
        }
        return results;
    }

    private static List<EventLogResponse> queryEventLogs() {
        List<EventLogResponse> results = new List<EventLogResponse>();
        for (Governance_Event__c eventRecord : [
            SELECT
                Id,
                Name,
                Details__c,
                Occurred_On__c,
                Event_Type__c,
                Severity__c
            FROM Governance_Event__c
            ORDER BY Occurred_On__c DESC, CreatedDate DESC
            LIMIT 100
        ]) {
            EventLogResponse responseItem = new EventLogResponse();
            responseItem.id = eventRecord.Id;
            responseItem.title = eventRecord.Name;
            responseItem.details = eventRecord.Details__c;
            responseItem.timeLabel = eventRecord.Occurred_On__c == null
                ? 'Unknown'
                : eventRecord.Occurred_On__c.format('MMM d, h:mm a');
            responseItem.badge = eventBadge(eventRecord);
            responseItem.tone = eventTone(eventRecord);
            results.add(responseItem);
        }
        return results;
    }

    private static void createAsset(AssetCreateRequest requestBody) {
        if (requestBody == null || String.isBlank(requestBody.name) || String.isBlank(requestBody.department)) {
            throw buildRestException('Asset name and department are required.', 400);
        }

        Metadata_Asset__c assetRecord = new Metadata_Asset__c(
            Name = requestBody.name.trim(),
            API_Name__c = generateApiName(requestBody.name),
            Asset_Type__c = normalizeAssetType(requestBody.assetType),
            Department__c = requestBody.department.trim(),
            Owner_User__c = String.isBlank(requestBody.ownerUserId) ? null : Id.valueOf(requestBody.ownerUserId),
            Health_Status__c = normalizeHealthStatus(requestBody.healthStatus),
            Health_Score__c = defaultHealthScore(requestBody.healthStatus),
            Risk_Level__c = 'Medium',
            Last_Used_On__c = Date.today(),
            Last_Attested_On__c = Date.today(),
            Stale_Days__c = 0,
            Source_System__c = 'Data Curator'
        );
        insert assetRecord;

        insert new Governance_Event__c(
            Name = buildEventName('Asset Created', assetRecord.Name),
            Metadata_Asset__c = assetRecord.Id,
            Event_Type__c = 'AgentRecommendation',
            Severity__c = 'Info',
            Occurred_On__c = System.now(),
            Actor_Label__c = UserInfo.getName(),
            Details__c = 'Created metadata asset ' + assetRecord.Name + ' from the Data Curator app.'
        );
    }

    private static void createTask(TaskCreateRequest requestBody) {
        if (requestBody == null || String.isBlank(requestBody.title)) {
            throw buildRestException('Task title is required.', 400);
        }

        Governance_Task__c taskRecord = new Governance_Task__c(
            Name = requestBody.title.trim(),
            Assigned_To__c = String.isBlank(requestBody.ownerUserId) ? null : Id.valueOf(requestBody.ownerUserId),
            Due_On__c = parseDate(requestBody.dueDate),
            Priority__c = normalizePriority(requestBody.priority),
            Status__c = 'New',
            Task_Type__c = String.isBlank(requestBody.taskType) ? 'OwnershipRecovery' : requestBody.taskType,
            Recommended_Action__c = String.isBlank(requestBody.recommendedAction)
                ? 'Review and complete the governance follow-up.'
                : requestBody.recommendedAction,
            Metadata_Asset__c = String.isBlank(requestBody.metadataAssetId) ? null : Id.valueOf(requestBody.metadataAssetId),
            Agent_Suggested__c = false
        );
        insert taskRecord;

        insert new Governance_Event__c(
            Name = buildEventName('Task Added', taskRecord.Name),
            Metadata_Asset__c = taskRecord.Metadata_Asset__c,
            Event_Type__c = 'AgentRecommendation',
            Severity__c = 'Info',
            Occurred_On__c = System.now(),
            Actor_Label__c = UserInfo.getName(),
            Details__c = 'Created governance task ' + taskRecord.Name + '.'
        );
    }

    private static void assignOwner(AssignOwnerRequest requestBody) {
        if (requestBody == null || String.isBlank(requestBody.assetId) || String.isBlank(requestBody.ownerUserId)) {
            throw buildRestException('Asset and owner are required.', 400);
        }

        DataCuratorGovernanceService.assignMetadataOwnerById(
            Id.valueOf(requestBody.assetId),
            Id.valueOf(requestBody.ownerUserId)
        );
    }

    private static void runFullScan() {
        ImportAssetsResponse importSummary = importOrgMetadataInventory();
        DataCuratorGovernanceService.InventoryResult inventoryResult =
            DataCuratorGovernanceService.getMetadataInventory('all', 'all');
        Map<String, Object> snapshot =
            (Map<String, Object>) JSON.deserializeUntyped(inventoryResult.inventorySnapshot);
        Datetime nowValue = System.now();

        Scan_Run__c scanRun = new Scan_Run__c(
            Name = 'Full Scan ' + nowValue.format('yyyy-MM-dd HH:mm'),
            Scope__c = 'Full Inventory',
            Status__c = 'Completed',
            Started_On__c = nowValue,
            Completed_On__c = nowValue,
            Assets_Scanned__c = integerValue(snapshot.get('totalAssets')),
            Stale_Count__c = inventoryResult.staleCount,
            Unassigned_Count__c = inventoryResult.unassignedCount,
            Duplicate_Clusters__c = integerValue(snapshot.get('duplicateClusterCount')),
            Summary__c = buildScanSummary(snapshot, inventoryResult.healthScore)
                + ' Imported '
                + importSummary.importedCount
                + ' org metadata assets.'
        );
        insert scanRun;

        insert new Governance_Event__c(
            Name = 'Full Inventory Scan Completed',
            Scan_Run__c = scanRun.Id,
            Event_Type__c = 'ScanCompleted',
            Severity__c = 'Info',
            Occurred_On__c = nowValue,
            Actor_Label__c = 'Data Curator',
            Details__c = 'Completed a full scan across '
                + String.valueOf(scanRun.Assets_Scanned__c)
                + ' assets. Health score: '
                + String.valueOf(inventoryResult.healthScore)
                + '. Imported '
                + importSummary.importedCount
                + ' metadata definitions from the org.'
        );
    }

    private static void runStaleReview(ScanRequest requestBody) {
        String departmentFilter = requestBody == null ? null : requestBody.departmentFilter;
        Integer thresholdDays = requestBody == null ? DEFAULT_STALE_THRESHOLD_DAYS : requestBody.staleThresholdDays;
        if (thresholdDays == null || thresholdDays <= 0) {
            thresholdDays = DEFAULT_STALE_THRESHOLD_DAYS;
        }

        List<String> filters = new List<String>{
            '(Health_Status__c = \'Stale\' OR Stale_Days__c >= ' + String.valueOf(thresholdDays) + ')'
        };
        if (!String.isBlank(departmentFilter)) {
            filters.add('Department__c = \'' + String.escapeSingleQuotes(departmentFilter) + '\'');
        }

        List<Metadata_Asset__c> staleAssets = Database.query(
            'SELECT Id, Name, Health_Status__c, Health_Score__c, Last_Attested_On__c, Stale_Days__c'
            + ' FROM Metadata_Asset__c'
            + ' WHERE ' + String.join(filters, ' AND ')
        );

        for (Metadata_Asset__c assetRecord : staleAssets) {
            assetRecord.Health_Status__c = 'Stale';
            assetRecord.Health_Score__c = assetRecord.Health_Score__c == null
                ? 40
                : minimumDecimal(assetRecord.Health_Score__c, 55);
            assetRecord.Last_Attested_On__c = Date.today().addDays(-thresholdDays);
            assetRecord.Stale_Days__c = thresholdDays;
        }
        if (!staleAssets.isEmpty()) {
            update staleAssets;
        }

        DataCuratorGovernanceService.StaleReviewResult reviewResult =
            DataCuratorGovernanceService.runStaleReview(departmentFilter, thresholdDays);
        Datetime nowValue = System.now();

        Scan_Run__c scanRun = new Scan_Run__c(
            Name = 'Stale Review ' + nowValue.format('yyyy-MM-dd HH:mm'),
            Scope__c = String.isBlank(departmentFilter) ? 'Stale Review' : 'Stale Review - ' + departmentFilter,
            Status__c = 'Completed',
            Started_On__c = nowValue,
            Completed_On__c = nowValue,
            Assets_Scanned__c = reviewResult.staleAssetCount,
            Stale_Count__c = reviewResult.staleAssetCount,
            Unassigned_Count__c = 0,
            Duplicate_Clusters__c = 0,
            Summary__c = 'Reviewed stale metadata with a threshold of '
                + thresholdDays
                + ' days and found '
                + reviewResult.staleAssetCount
                + ' stale assets.'
        );
        insert scanRun;

        insert new Governance_Event__c(
            Name = 'Stale Metadata Review Completed',
            Scan_Run__c = scanRun.Id,
            Event_Type__c = 'StaleAlert',
            Severity__c = reviewResult.criticalAssetCount > 0 ? 'Warning' : 'Info',
            Occurred_On__c = nowValue,
            Actor_Label__c = 'Data Curator',
            Details__c = 'Reviewed stale metadata and identified '
                + reviewResult.staleAssetCount
                + ' stale assets, including '
                + reviewResult.criticalAssetCount
                + ' critical assets.'
        );
    }

    private static void runBulkAction(BulkActionRequest requestBody) {
        if (requestBody == null || requestBody.assetIds == null || requestBody.assetIds.isEmpty()) {
            throw buildRestException('Select at least one asset for a bulk action.', 400);
        }

        Set<Id> assetIds = new Set<Id>();
        for (String assetId : requestBody.assetIds) {
            if (!String.isBlank(assetId)) {
                assetIds.add(Id.valueOf(assetId));
            }
        }
        if (assetIds.isEmpty()) {
            throw buildRestException('No valid asset IDs were supplied.', 400);
        }

        List<Metadata_Asset__c> assets = [
            SELECT Id, Name, Health_Status__c, Health_Score__c
            FROM Metadata_Asset__c
            WHERE Id IN :assetIds
        ];

        if (requestBody.action == 'assign_owner') {
            if (String.isBlank(requestBody.ownerUserId)) {
                throw buildRestException('An owner is required for bulk owner assignment.', 400);
            }
            Id ownerId = Id.valueOf(requestBody.ownerUserId);
            for (Metadata_Asset__c assetRecord : assets) {
                DataCuratorGovernanceService.assignMetadataOwnerById(assetRecord.Id, ownerId);
            }
            return;
        }

        if (requestBody.action == 'create_task') {
            List<Governance_Task__c> tasksToInsert = new List<Governance_Task__c>();
            for (Metadata_Asset__c assetRecord : assets) {
                tasksToInsert.add(
                    new Governance_Task__c(
                        Name = defaultString(requestBody.taskTitle, 'Remediate metadata asset') + ': ' + assetRecord.Name,
                        Assigned_To__c = UserInfo.getUserId(),
                        Due_On__c = Date.today().addDays(2),
                        Priority__c = normalizePriority(requestBody.taskPriority),
                        Status__c = 'New',
                        Task_Type__c = 'OwnershipRecovery',
                        Recommended_Action__c = 'Review asset health and complete the remediation step.',
                        Metadata_Asset__c = assetRecord.Id,
                        Agent_Suggested__c = true
                    )
                );
            }
            if (!tasksToInsert.isEmpty()) {
                insert tasksToInsert;
            }
            insert new Governance_Event__c(
                Name = 'Bulk Remediation Tasks Created',
                Event_Type__c = 'AgentRecommendation',
                Severity__c = 'Info',
                Occurred_On__c = System.now(),
                Actor_Label__c = UserInfo.getName(),
                Details__c = 'Created ' + tasksToInsert.size() + ' remediation tasks from the Data Curator app.'
            );
            return;
        }

        if (requestBody.action == 'mark_healthy') {
            for (Metadata_Asset__c assetRecord : assets) {
                assetRecord.Health_Status__c = 'Healthy';
                assetRecord.Health_Score__c = assetRecord.Health_Score__c == null
                    ? 92
                    : maximumDecimal(assetRecord.Health_Score__c, 92);
                assetRecord.Stale_Days__c = 0;
            }
            update assets;
            insert new Governance_Event__c(
                Name = 'Bulk Remediation Applied',
                Event_Type__c = 'AgentRecommendation',
                Severity__c = 'Info',
                Occurred_On__c = System.now(),
                Actor_Label__c = UserInfo.getName(),
                Details__c = 'Marked ' + assets.size() + ' assets healthy from the Data Curator app.'
            );
            return;
        }

        throw buildRestException('Unsupported bulk action.', 400);
    }

    private static void recordExport(ExportRequest requestBody) {
        String exportFormat = requestBody == null || String.isBlank(requestBody.format)
            ? 'CSV'
            : requestBody.format.trim().toUpperCase();
        Integer rowCount = requestBody == null || requestBody.rowCount == null ? 0 : requestBody.rowCount;

        List<String> filterParts = new List<String>();
        if (requestBody != null && !String.isBlank(requestBody.department) && requestBody.department != 'All') {
            filterParts.add('Department: ' + requestBody.department);
        }
        if (requestBody != null && !String.isBlank(requestBody.type) && requestBody.type != 'All') {
            filterParts.add('Type: ' + requestBody.type);
        }
        if (requestBody != null && !String.isBlank(requestBody.status) && requestBody.status != 'All') {
            filterParts.add('Status: ' + requestBody.status);
        }
        if (requestBody != null && !String.isBlank(requestBody.ownership) && requestBody.ownership != 'All') {
            filterParts.add('Ownership: ' + requestBody.ownership);
        }

        insert new Governance_Event__c(
            Name = 'Explorer Export Generated',
            Event_Type__c = 'AgentRecommendation',
            Severity__c = 'Info',
            Occurred_On__c = System.now(),
            Actor_Label__c = UserInfo.getName(),
            Details__c = 'Exported ' + rowCount + ' rows as ' + exportFormat
                + (filterParts.isEmpty() ? '.' : ' with filters ' + String.join(filterParts, ', ') + '.')
        );
    }

    private static ImportAssetsResponse importAssets(ImportAssetsRequest requestBody) {
        if (requestBody == null || requestBody.assets == null || requestBody.assets.isEmpty()) {
            throw buildRestException('At least one discovered metadata asset is required.', 400);
        }

        Set<String> externalKeys = new Set<String>();
        for (ImportedAssetRequest assetRequest : requestBody.assets) {
            if (assetRequest != null && !String.isBlank(assetRequest.externalKey)) {
                externalKeys.add(assetRequest.externalKey.trim());
            }
        }

        if (externalKeys.isEmpty()) {
            throw buildRestException('Imported assets must include an external key.', 400);
        }

        Map<String, Metadata_Asset__c> existingByExternalKey = new Map<String, Metadata_Asset__c>();
        for (Metadata_Asset__c existingAsset : [
            SELECT
                Id,
                External_Key__c,
                Name,
                API_Name__c,
                Asset_Type__c,
                Department__c,
                Owner_User__c,
                Health_Status__c,
                Health_Score__c,
                Risk_Level__c,
                Source_System__c,
                Stewardship_Notes__c,
                Stale_Days__c,
                Last_Used_On__c,
                Last_Attested_On__c
            FROM Metadata_Asset__c
            WHERE External_Key__c IN :externalKeys
        ]) {
            existingByExternalKey.put(existingAsset.External_Key__c, existingAsset);
        }

        List<Metadata_Asset__c> assetsToUpsert = new List<Metadata_Asset__c>();
        Integer createdCount = 0;
        Integer updatedCount = 0;

        for (ImportedAssetRequest assetRequest : requestBody.assets) {
            if (assetRequest == null || String.isBlank(assetRequest.externalKey) || String.isBlank(assetRequest.apiName)) {
                continue;
            }

            String normalizedExternalKey = assetRequest.externalKey.trim();
            Metadata_Asset__c assetRecord = existingByExternalKey.containsKey(normalizedExternalKey)
                ? existingByExternalKey.get(normalizedExternalKey)
                : new Metadata_Asset__c(External_Key__c = normalizedExternalKey);

            if (assetRecord.Id == null) {
                createdCount++;
            } else {
                updatedCount++;
            }

            assetRecord.Name = String.isBlank(assetRequest.name) ? assetRequest.apiName.trim() : assetRequest.name.trim();
            assetRecord.API_Name__c = assetRequest.apiName.trim();
            assetRecord.Asset_Type__c = normalizeAssetType(assetRequest.assetType);
            assetRecord.Department__c = String.isBlank(assetRequest.department) ? inferDepartment(assetRecord.Asset_Type__c) : assetRequest.department.trim();
            assetRecord.Health_Status__c = normalizeHealthStatus(assetRequest.healthStatus);
            assetRecord.Health_Score__c = assetRequest.healthScore == null
                ? defaultHealthScore(assetRequest.healthStatus)
                : assetRequest.healthScore;
            assetRecord.Risk_Level__c = String.isBlank(assetRequest.riskLevel) ? 'Medium' : assetRequest.riskLevel.trim();
            assetRecord.Source_System__c = String.isBlank(assetRequest.sourceSystem) ? 'Salesforce Org Scan' : assetRequest.sourceSystem.trim();
            assetRecord.Stale_Days__c = assetRequest.staleDays;

            Date lastUsedOn = parseDateOrNull(assetRequest.lastUsedOn);
            if (lastUsedOn != null) {
                assetRecord.Last_Used_On__c = lastUsedOn;
            }

            Date lastAttestedOn = parseDateOrNull(assetRequest.lastAttestedOn);
            if (lastAttestedOn != null) {
                assetRecord.Last_Attested_On__c = lastAttestedOn;
            }

            if (!String.isBlank(assetRequest.stewardshipNotes)) {
                assetRecord.Stewardship_Notes__c = assetRequest.stewardshipNotes.trim();
            }

            assetsToUpsert.add(assetRecord);
        }

        if (!assetsToUpsert.isEmpty()) {
            upsert assetsToUpsert External_Key__c;
        }

        ImportAssetsResponse response = new ImportAssetsResponse();
        response.importedCount = assetsToUpsert.size();
        response.createdCount = createdCount;
        response.updatedCount = updatedCount;
        return response;
    }

    private static ImportAssetsResponse importOrgMetadataInventory() {
        ImportAssetsRequest requestBody = new ImportAssetsRequest();
        requestBody.assets = new List<ImportedAssetRequest>();

        List<String> customObjectApiNames = new List<String>();
        for (EntityDefinition entityRecord : [
            SELECT QualifiedApiName, Label, DurableId
            FROM EntityDefinition
            WHERE IsCustomizable = true
            ORDER BY QualifiedApiName
            LIMIT 2000
        ]) {
            if (!isSupportedCustomMetadataApiName(entityRecord.QualifiedApiName)) {
                continue;
            }

            requestBody.assets.add(buildImportedAsset(
                'object:' + entityRecord.QualifiedApiName,
                defaultString(entityRecord.Label, entityRecord.QualifiedApiName),
                entityRecord.QualifiedApiName,
                'Object',
                'Data Model',
                92,
                'Imported from org object metadata.'
            ));
            customObjectApiNames.add(entityRecord.QualifiedApiName);
        }

        Integer queriedObjects = 0;
        for (String objectApiName : customObjectApiNames) {
            queriedObjects++;
            if (queriedObjects > 80) {
                break;
            }

            for (FieldDefinition fieldRecord : [
                SELECT QualifiedApiName, DurableId, DataType
                FROM FieldDefinition
                WHERE EntityDefinition.QualifiedApiName = :objectApiName
                ORDER BY QualifiedApiName
                LIMIT 1000
            ]) {
                if (!fieldRecord.QualifiedApiName.endsWith('__c')) {
                    continue;
                }

                requestBody.assets.add(buildImportedAsset(
                    'field:' + fieldRecord.DurableId,
                    objectApiName + '.' + fieldRecord.QualifiedApiName,
                    fieldRecord.DurableId,
                    'Field',
                    'Data Model',
                    89,
                    'Imported from org field metadata. Type: ' + defaultString(fieldRecord.DataType, 'Unknown') + '.'
                ));
            }
        }

        for (FlowDefinitionView flowRecord : [
            SELECT ApiName, Label
            FROM FlowDefinitionView
            LIMIT 2000
        ]) {
            requestBody.assets.add(buildImportedAsset(
                'flow:' + flowRecord.ApiName,
                defaultString(flowRecord.Label, flowRecord.ApiName),
                flowRecord.ApiName,
                'Flow',
                'Automation',
                90,
                'Imported from org flow metadata.'
            ));
        }

        for (PermissionSet permissionSetRecord : [
            SELECT Name, Label, IsOwnedByProfile
            FROM PermissionSet
            WHERE IsOwnedByProfile = false
            ORDER BY Name
            LIMIT 2000
        ]) {
            requestBody.assets.add(buildImportedAsset(
                'permissionset:' + permissionSetRecord.Name,
                defaultString(permissionSetRecord.Label, permissionSetRecord.Name),
                permissionSetRecord.Name,
                'PermissionSet',
                'Security',
                91,
                'Imported from org permission set metadata.'
            ));
        }

        return importAssets(requestBody);
    }

    private static Object parseBody(Type targetType) {
        if (RestContext.request == null || RestContext.request.requestBody == null) {
            return null;
        }

        String body = RestContext.request.requestBody.toString();
        if (String.isBlank(body)) {
            return null;
        }

        return JSON.deserialize(body, targetType);
    }

    private static String getRoute() {
        String requestUri = RestContext.request.requestURI;
        if (String.isBlank(requestUri)) {
            return '';
        }

        Integer markerIndex = requestUri.indexOf(API_BASE_PATH);
        if (markerIndex >= 0) {
            return requestUri.substring(markerIndex + API_BASE_PATH.length());
        }

        markerIndex = requestUri.indexOf(ROUTE_PREFIX);
        if (markerIndex >= 0) {
            return requestUri.substring(markerIndex + ROUTE_PREFIX.length());
        }

        return requestUri.startsWith('/') ? requestUri.substring(1) : requestUri;
    }

    private static void writeJson(Integer statusCode, Object payload) {
        RestContext.response.statusCode = statusCode;
        RestContext.response.addHeader('Content-Type', 'application/json');
        RestContext.response.responseBody = Blob.valueOf(JSON.serialize(payload));
    }

    private static void handleError(Exception error) {
        Integer statusCode = 500;
        String message = error.getMessage();
        if (error instanceof DataCuratorGovernanceRestException) {
            statusCode = ((DataCuratorGovernanceRestException) error).statusCode;
            message = ((DataCuratorGovernanceRestException) error).publicMessage;
        }
        writeJson(statusCode, new ErrorResponse(message, null));
    }

    private static DataCuratorGovernanceRestException buildRestException(
        String message,
        Integer statusCode
    ) {
        DataCuratorGovernanceRestException error = new DataCuratorGovernanceRestException();
        error.statusCode = statusCode;
        error.publicMessage = message;
        return error;
    }

    private static String normalizeAssetType(String assetType) {
        Set<String> allowedValues = new Set<String>{
            'Object',
            'Field',
            'Flow',
            'ApexClass',
            'ValidationRule',
            'PermissionSet',
            'Integration',
            'PromptTemplate',
            'Other'
        };
        return allowedValues.contains(assetType) ? assetType : 'Other';
    }

    private static String normalizeHealthStatus(String healthStatus) {
        Set<String> allowedValues = new Set<String>{ 'Healthy', 'Stale', 'Duplicate', 'NeedsReview' };
        return allowedValues.contains(healthStatus) ? healthStatus : 'Healthy';
    }

    private static String normalizePriority(String priority) {
        Set<String> allowedValues = new Set<String>{ 'Low', 'Medium', 'High', 'Critical' };
        return allowedValues.contains(priority) ? priority : 'Medium';
    }

    private static Decimal defaultHealthScore(String healthStatus) {
        String normalizedStatus = normalizeHealthStatus(healthStatus);
        if (normalizedStatus == 'Duplicate') {
            return 72;
        }
        if (normalizedStatus == 'Stale') {
            return 54;
        }
        if (normalizedStatus == 'NeedsReview') {
            return 65;
        }
        return 95;
    }

    private static Date parseDate(String rawValue) {
        if (String.isBlank(rawValue)) {
            return Date.today().addDays(3);
        }

        try {
            return Date.valueOf(rawValue);
        } catch (Exception ignored) {
            return Date.today().addDays(3);
        }
    }

    private static Date parseDateOrNull(String rawValue) {
        if (String.isBlank(rawValue)) {
            return null;
        }

        try {
            return Date.valueOf(rawValue);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String generateApiName(String rawName) {
        String baseValue = rawName == null ? 'Metadata_Asset' : rawName.replaceAll('[^a-zA-Z0-9]+', '_');
        if (!baseValue.endsWith('__mdt')) {
            baseValue += '__mdt';
        }
        return baseValue.left(Math.min(baseValue.length(), 80));
    }

    private static String buildScanSummary(Map<String, Object> snapshot, Decimal healthScore) {
        return 'Scanned '
            + String.valueOf(integerValue(snapshot.get('totalAssets')))
            + ' assets with '
            + String.valueOf(integerValue(snapshot.get('duplicateClusterCount')))
            + ' duplicate clusters and an average health score of '
            + String.valueOf(healthScore)
            + '.';
    }

    private static String eventBadge(Governance_Event__c eventRecord) {
        if (eventRecord.Event_Type__c == 'ScanCompleted') {
            return 'Automated';
        }
        if (eventRecord.Severity__c == 'Critical') {
            return 'Critical';
        }
        if (eventRecord.Event_Type__c == 'OwnerAssigned') {
            return 'Manual Action';
        }
        if (eventRecord.Event_Type__c == 'StaleAlert') {
            return 'Review';
        }
        return 'Update';
    }

    private static String eventTone(Governance_Event__c eventRecord) {
        if (eventRecord.Severity__c == 'Critical') {
            return 'danger';
        }
        if (eventRecord.Event_Type__c == 'ScanCompleted') {
            return 'accent';
        }
        return 'neutral';
    }

    private static Integer integerValue(Object value) {
        if (value == null) {
            return 0;
        }
        if (value instanceof Integer) {
            return (Integer) value;
        }
        if (value instanceof Decimal) {
            return ((Decimal) value).intValue();
        }
        return Integer.valueOf(String.valueOf(value));
    }

    private static String defaultString(String value, String fallback) {
        return String.isBlank(value) ? fallback : value;
    }

    private static ImportedAssetRequest buildImportedAsset(
        String externalKey,
        String name,
        String apiName,
        String assetType,
        String department,
        Decimal healthScore,
        String stewardshipNotes
    ) {
        ImportedAssetRequest assetRequest = new ImportedAssetRequest();
        assetRequest.externalKey = externalKey;
        assetRequest.name = shortenAssetName(name, apiName);
        assetRequest.apiName = apiName;
        assetRequest.assetType = assetType;
        assetRequest.department = department;
        assetRequest.healthStatus = 'Healthy';
        assetRequest.healthScore = healthScore;
        assetRequest.riskLevel = 'Medium';
        assetRequest.sourceSystem = 'Salesforce Org Scan';
        assetRequest.stewardshipNotes = stewardshipNotes;
        assetRequest.lastAttestedOn = String.valueOf(Date.today());
        return assetRequest;
    }

    private static Boolean isSupportedCustomMetadataApiName(String apiName) {
        if (String.isBlank(apiName)) {
            return false;
        }

        return apiName.endsWith('__c')
            || apiName.endsWith('__mdt')
            || apiName.endsWith('__e')
            || apiName.endsWith('__b')
            || apiName.endsWith('__x');
    }

    private static String shortenAssetName(String preferredName, String apiName) {
        String candidate = String.isBlank(preferredName) ? apiName : preferredName;
        if (String.isBlank(candidate)) {
            return 'Imported Metadata Asset';
        }

        if (candidate.length() <= 80) {
            return candidate;
        }

        if (!String.isBlank(apiName) && apiName.length() <= 80) {
            return apiName;
        }

        return candidate.left(80);
    }

    private static String inferDepartment(String assetType) {
        if (assetType == 'Flow') {
            return 'Automation';
        }
        if (assetType == 'ApexClass') {
            return 'Code';
        }
        if (assetType == 'PermissionSet') {
            return 'Security';
        }
        return 'Data Model';
    }

    private static Decimal minimumDecimal(Decimal leftValue, Decimal rightValue) {
        return leftValue <= rightValue ? leftValue : rightValue;
    }

    private static Decimal maximumDecimal(Decimal leftValue, Decimal rightValue) {
        return leftValue >= rightValue ? leftValue : rightValue;
    }

    private static String buildEventName(String prefix, String targetName) {
        String candidateName = String.isBlank(targetName) ? prefix : prefix + ' - ' + targetName;
        if (candidateName.length() <= 80) {
            return candidateName;
        }
        return candidateName.left(80);
    }
}
