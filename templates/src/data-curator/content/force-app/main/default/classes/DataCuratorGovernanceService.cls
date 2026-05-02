public with sharing class DataCuratorGovernanceService {
    private static final Integer DEFAULT_STALE_THRESHOLD_DAYS = 180;
    private static final Decimal DEFAULT_DUPLICATE_CONFIDENCE = 0.80;
    private static final Decimal DEFAULT_CLUSTER_SAVINGS = 250;

    public class InventoryResult {
        public String inventorySnapshot;
        public String departmentFilterUsed;
        public Decimal healthScore;
        public Integer unassignedCount;
        public Integer staleCount;
    }

    public class StaleReviewResult {
        public String reviewSnapshot;
        public Integer staleAssetCount;
        public Integer criticalAssetCount;
    }

    public class OwnerProposalResult {
        public String assetName;
        public Id recommendedOwnerId;
        public String recommendedOwnerName;
        public String reasoningSummary;
    }

    public class OwnerAssignmentResult {
        public String assignmentStatus;
        public Id auditRecordId;
    }

    public class DuplicatePlanResult {
        public String planSummary;
        public Integer duplicateClusterCount;
        public Decimal projectedMonthlySavings;
    }

    public static String generateGovernanceSummary(String requestContext, String inventorySnapshot) {
        Map<String, Object> snapshot = parseJsonObject(inventorySnapshot);
        String departmentFilterUsed = stringValue(snapshot.get('departmentFilterUsed'));
        Integer totalAssets = integerValue(snapshot.get('totalAssets'));
        Decimal healthScore = decimalValue(snapshot.get('healthScore'));
        Integer staleCount = integerValue(snapshot.get('staleCount'));
        Integer unassignedCount = integerValue(snapshot.get('unassignedCount'));
        Integer duplicateClusterCount = integerValue(snapshot.get('duplicateClusterCount'));
        Decimal ownershipCoverage = decimalValue(snapshot.get('ownershipCoverage'));

        List<String> sections = new List<String>();
        sections.add('Executive Summary');
        sections.add('Scope: ' + defaultString(departmentFilterUsed, 'all metadata assets') + '.');
        sections.add(
            'Current posture: health score '
            + formatDecimal(healthScore)
            + ' across '
            + formatInteger(totalAssets)
            + ' assets with '
            + formatDecimal(ownershipCoverage)
            + '% ownership coverage.'
        );
        sections.add(
            'Top risks: '
            + formatInteger(staleCount)
            + ' stale assets, '
            + formatInteger(unassignedCount)
            + ' unassigned assets, and '
            + formatInteger(duplicateClusterCount)
            + ' duplicate clusters.'
        );
        sections.add(
            'Recommended next action: '
            + recommendPrimaryAction(staleCount, unassignedCount, duplicateClusterCount)
        );

        if (!String.isBlank(requestContext)) {
            sections.add('Context: ' + requestContext);
        }
        return String.join(sections, '\n');
    }

    public static String generateStaleBrief(String requestContext, String reviewSnapshot) {
        Map<String, Object> snapshot = parseJsonObject(reviewSnapshot);
        Integer staleAssetCount = integerValue(snapshot.get('staleAssetCount'));
        Integer criticalAssetCount = integerValue(snapshot.get('criticalAssetCount'));
        Integer staleThresholdDays = integerValue(snapshot.get('staleThresholdDays'));
        String departmentFilterUsed = stringValue(snapshot.get('departmentFilterUsed'));

        List<String> sections = new List<String>();
        sections.add('Stale Metadata Brief');
        sections.add(
            'Scope: '
            + defaultString(departmentFilterUsed, 'all metadata assets')
            + ' with a threshold of '
            + formatInteger(staleThresholdDays)
            + ' days.'
        );
        sections.add(
            'Risk summary: '
            + formatInteger(staleAssetCount)
            + ' stale assets were identified, including '
            + formatInteger(criticalAssetCount)
            + ' with elevated operational risk.'
        );
        sections.add(
            'Recommended next step: prioritize re-attestation for high-risk assets first, then review the remainder for archival or ownership reassignment.'
        );

        if (!String.isBlank(requestContext)) {
            sections.add('Context: ' + requestContext);
        }
        return String.join(sections, '\n');
    }

    public static String generateOwnerMessage(String assetName, String requestContext) {
        String resolvedAssetName = String.isBlank(assetName) ? 'the selected metadata asset' : assetName;
        List<String> sections = new List<String>();
        sections.add('Owner Outreach Draft');
        sections.add('Hello,');
        sections.add(
            'You are being asked to steward '
            + resolvedAssetName
            + ' because it requires clear ownership for governance, attestation, and remediation decisions.'
        );
        sections.add(
            'Please review the asset, confirm whether you are the right steward, and capture any follow-up actions or exceptions.'
        );

        if (!String.isBlank(requestContext)) {
            sections.add('Additional context: ' + requestContext);
        }
        return String.join(sections, '\n');
    }

    public static String generateCleanupSummary(String requestContext, String planSummary) {
        Map<String, Object> snapshot = parseJsonObject(planSummary);
        Integer duplicateClusterCount = integerValue(snapshot.get('duplicateClusterCount'));
        Decimal projectedMonthlySavings = decimalValue(snapshot.get('projectedMonthlySavings'));
        String departmentFilterUsed = stringValue(snapshot.get('departmentFilterUsed'));

        List<String> sections = new List<String>();
        sections.add('Duplicate Cleanup Summary');
        sections.add('Scope: ' + defaultString(departmentFilterUsed, 'all metadata assets') + '.');
        sections.add(
            'Opportunity: '
            + formatInteger(duplicateClusterCount)
            + ' actionable duplicate clusters with an estimated monthly simplification value of $'
            + formatDecimal(projectedMonthlySavings)
            + '.'
        );
        sections.add(
            'Recommended approval path: validate dependencies on the healthiest asset in each cluster, then approve consolidation in phases with rollback checkpoints.'
        );

        if (!String.isBlank(requestContext)) {
            sections.add('Context: ' + requestContext);
        }
        return String.join(sections, '\n');
    }

    public static InventoryResult getMetadataInventory(String departmentFilter, String statusFilter) {
        String normalizedDepartment = normalizeDepartment(departmentFilter);
        Set<String> statuses = parseStatusFilter(statusFilter);
        List<Metadata_Asset__c> assets = queryAssets(normalizedDepartment, statuses, null, false);

        InventoryResult result = new InventoryResult();
        result.departmentFilterUsed = normalizedDepartment == null ? 'all' : normalizedDepartment;
        result.unassignedCount = countUnassigned(assets);
        result.staleCount = countStaleAssets(assets, DEFAULT_STALE_THRESHOLD_DAYS);
        result.healthScore = calculateAverageHealth(assets);

        Map<String, Object> snapshot = new Map<String, Object>{
            'departmentFilterUsed' => result.departmentFilterUsed,
            'generatedAt' => System.now().formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\''),
            'totalAssets' => assets.size(),
            'healthScore' => result.healthScore,
            'unassignedCount' => result.unassignedCount,
            'staleCount' => result.staleCount,
            'duplicateClusterCount' => countDuplicateClusters(assets),
            'ownershipCoverage' => calculateOwnershipCoverage(assets),
            'assets' => summarizeAssets(assets, 20),
            'departmentRollups' => buildDepartmentRollups(assets)
        };
        result.inventorySnapshot = JSON.serializePretty(snapshot);
        return result;
    }

    public static StaleReviewResult runStaleReview(String departmentFilter, Integer staleThresholdDays) {
        Integer thresholdDays = staleThresholdDays == null || staleThresholdDays <= 0
            ? DEFAULT_STALE_THRESHOLD_DAYS
            : staleThresholdDays;
        String normalizedDepartment = normalizeDepartment(departmentFilter);
        List<Metadata_Asset__c> assets = queryAssets(normalizedDepartment, new Set<String>(), null, false);
        List<Map<String, Object>> staleCandidates = new List<Map<String, Object>>();
        Integer criticalCount = 0;

        for (Metadata_Asset__c asset : assets) {
            Integer staleDays = resolveStaleDays(asset);
            if (asset.Health_Status__c == 'Stale' || staleDays >= thresholdDays) {
                if (asset.Risk_Level__c == 'High' || asset.Risk_Level__c == 'Critical') {
                    criticalCount++;
                }
                staleCandidates.add(summarizeAsset(asset, staleDays));
            }
        }

        StaleReviewResult result = new StaleReviewResult();
        result.staleAssetCount = staleCandidates.size();
        result.criticalAssetCount = criticalCount;
        result.reviewSnapshot = JSON.serializePretty(
            new Map<String, Object>{
                'departmentFilterUsed' => normalizedDepartment == null ? 'all' : normalizedDepartment,
                'staleThresholdDays' => thresholdDays,
                'generatedAt' => System.now().formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\''),
                'staleAssetCount' => result.staleAssetCount,
                'criticalAssetCount' => result.criticalAssetCount,
                'candidates' => staleCandidates
            }
        );
        return result;
    }

    public static OwnerProposalResult proposeOwnerAssignment(String assetName, String departmentFilter) {
        Metadata_Asset__c asset = findTargetAsset(assetName, departmentFilter);
        String targetDepartment = asset != null ? asset.Department__c : normalizeDepartment(departmentFilter);

        List<AggregateResult> ownershipCounts;
        if (String.isBlank(targetDepartment)) {
            ownershipCounts = [
                SELECT Owner_User__c ownerId, COUNT(Id) assetCount
                FROM Metadata_Asset__c
                WHERE Owner_User__c != null
                GROUP BY Owner_User__c
                ORDER BY COUNT(Id) ASC
            ];
        } else {
            ownershipCounts = [
                SELECT Owner_User__c ownerId, COUNT(Id) assetCount
                FROM Metadata_Asset__c
                WHERE Owner_User__c != null AND Department__c = :targetDepartment
                GROUP BY Owner_User__c
                ORDER BY COUNT(Id) ASC
            ];
        }

        Id recommendedOwnerId;
        Integer currentOwnerLoad = 0;
        if (!ownershipCounts.isEmpty()) {
            AggregateResult firstRow = ownershipCounts[0];
            recommendedOwnerId = (Id) firstRow.get('ownerId');
            currentOwnerLoad = (Integer) firstRow.get('assetCount');
        } else {
            recommendedOwnerId = UserInfo.getUserId();
        }

        User recommendedOwner = [
            SELECT Id, Name
            FROM User
            WHERE Id = :recommendedOwnerId
            LIMIT 1
        ];

        OwnerProposalResult result = new OwnerProposalResult();
        result.assetName = asset != null ? asset.Name : 'Department-level assignment request';
        result.recommendedOwnerId = recommendedOwner.Id;
        result.recommendedOwnerName = recommendedOwner.Name;
        result.reasoningSummary = asset == null
            ? 'No exact asset name was supplied, so the recommendation is based on stewardship load for the selected department.'
            : 'Recommended ' + recommendedOwner.Name + ' because they already steward related assets'
                + (String.isBlank(targetDepartment) ? '' : ' in ' + targetDepartment)
                + ' and currently have the lightest assignment load (' + currentOwnerLoad + ' assets).';
        return result;
    }

    public static OwnerAssignmentResult assignMetadataOwner(String assetName, Id ownerUserId) {
        OwnerAssignmentResult result = new OwnerAssignmentResult();
        Metadata_Asset__c asset = findTargetAsset(assetName, null);
        return assignMetadataOwner(asset, ownerUserId);
    }

    public static OwnerAssignmentResult assignMetadataOwnerById(Id assetId, Id ownerUserId) {
        OwnerAssignmentResult result = new OwnerAssignmentResult();
        if (assetId == null) {
            result.assignmentStatus = 'Asset not found';
            return result;
        }

        List<Metadata_Asset__c> assets = [
            SELECT Id, Name, Owner_User__c, Health_Status__c
            FROM Metadata_Asset__c
            WHERE Id = :assetId
            LIMIT 1
        ];
        Metadata_Asset__c asset = assets.isEmpty() ? null : assets[0];
        return assignMetadataOwner(asset, ownerUserId);
    }

    private static OwnerAssignmentResult assignMetadataOwner(Metadata_Asset__c asset, Id ownerUserId) {
        OwnerAssignmentResult result = new OwnerAssignmentResult();
        if (asset == null) {
            result.assignmentStatus = 'Asset not found';
            return result;
        }

        User ownerUser = [
            SELECT Id, Name
            FROM User
            WHERE Id = :ownerUserId
            LIMIT 1
        ];

        asset.Owner_User__c = ownerUser.Id;
        if (asset.Health_Status__c == 'NeedsReview') {
            asset.Health_Status__c = 'Healthy';
        }
        update asset;

        Governance_Event__c eventRecord = new Governance_Event__c(
            Name = 'Owner Assigned - ' + asset.Name.left(Math.min(asset.Name.length(), 55)),
            Metadata_Asset__c = asset.Id,
            Event_Type__c = 'OwnerAssigned',
            Severity__c = 'Info',
            Occurred_On__c = System.now(),
            Actor_Label__c = ownerUser.Name,
            Details__c = 'Ownership set to ' + ownerUser.Name + ' for asset ' + asset.Name + '.'
        );
        insert eventRecord;

        result.assignmentStatus = 'Assigned ' + ownerUser.Name + ' to ' + asset.Name;
        result.auditRecordId = eventRecord.Id;
        return result;
    }

    public static DuplicatePlanResult buildDuplicateCleanupPlan(String departmentFilter, Decimal confidenceThreshold) {
        Decimal threshold = confidenceThreshold == null ? DEFAULT_DUPLICATE_CONFIDENCE : confidenceThreshold;
        String normalizedDepartment = normalizeDepartment(departmentFilter);
        List<Metadata_Asset__c> assets = queryAssets(normalizedDepartment, new Set<String>(), null, true);
        Map<String, List<Metadata_Asset__c>> groupedAssets = new Map<String, List<Metadata_Asset__c>>();

        for (Metadata_Asset__c asset : assets) {
            if (!groupedAssets.containsKey(asset.Duplicate_Group_Key__c)) {
                groupedAssets.put(asset.Duplicate_Group_Key__c, new List<Metadata_Asset__c>());
            }
            groupedAssets.get(asset.Duplicate_Group_Key__c).add(asset);
        }

        List<Map<String, Object>> clusters = new List<Map<String, Object>>();
        Decimal projectedSavings = 0;

        for (String clusterKey : groupedAssets.keySet()) {
            List<Metadata_Asset__c> clusterAssets = groupedAssets.get(clusterKey);
            if (clusterAssets.size() < 2) {
                continue;
            }

            Decimal confidenceScore = calculateClusterConfidence(clusterAssets);
            if (confidenceScore < threshold) {
                continue;
            }

            projectedSavings += (clusterAssets.size() - 1) * DEFAULT_CLUSTER_SAVINGS;
            clusters.add(
                new Map<String, Object>{
                    'clusterKey' => clusterKey,
                    'confidence' => confidenceScore.setScale(2),
                    'assetCount' => clusterAssets.size(),
                    'projectedMonthlySavings' => ((clusterAssets.size() - 1) * DEFAULT_CLUSTER_SAVINGS).setScale(2),
                    'recommendedAction' => 'Consolidate to the healthiest asset in the cluster after dependency review.',
                    'assets' => summarizeAssets(clusterAssets, clusterAssets.size())
                }
            );
        }

        DuplicatePlanResult result = new DuplicatePlanResult();
        result.duplicateClusterCount = clusters.size();
        result.projectedMonthlySavings = projectedSavings.setScale(2);
        result.planSummary = JSON.serializePretty(
            new Map<String, Object>{
                'departmentFilterUsed' => normalizedDepartment == null ? 'all' : normalizedDepartment,
                'confidenceThreshold' => threshold.setScale(2),
                'generatedAt' => System.now().formatGmt('yyyy-MM-dd\'T\'HH:mm:ss\'Z\''),
                'duplicateClusterCount' => result.duplicateClusterCount,
                'projectedMonthlySavings' => result.projectedMonthlySavings,
                'clusters' => clusters
            }
        );
        return result;
    }

    private static List<Metadata_Asset__c> queryAssets(
        String departmentFilter,
        Set<String> statuses,
        String assetName,
        Boolean requireDuplicateGroup
    ) {
        List<String> filters = new List<String>();

        if (!String.isBlank(departmentFilter)) {
            filters.add('Department__c = \'' + String.escapeSingleQuotes(departmentFilter) + '\'');
        }

        if (statuses != null && !statuses.isEmpty()) {
            List<String> escapedStatuses = new List<String>();
            for (String statusValue : statuses) {
                escapedStatuses.add('\'' + String.escapeSingleQuotes(statusValue) + '\'');
            }
            filters.add('Health_Status__c IN (' + String.join(escapedStatuses, ',') + ')');
        }

        if (!String.isBlank(assetName)) {
            String escapedAssetName = String.escapeSingleQuotes(assetName);
            filters.add('(Name = \'' + escapedAssetName + '\' OR API_Name__c = \'' + escapedAssetName + '\')');
        }

        if (requireDuplicateGroup == true) {
            filters.add('Duplicate_Group_Key__c != null');
            filters.add('Duplicate_Group_Key__c != \'\'');
        }

        String queryString =
            'SELECT Id, Name, API_Name__c, Asset_Type__c, Department__c, Owner_User__c, Owner_User__r.Name,'
            + ' Health_Status__c, Health_Score__c, Risk_Level__c, Last_Used_On__c, Last_Attested_On__c,'
            + ' Duplicate_Group_Key__c, Stale_Days__c, Source_System__c'
            + ' FROM Metadata_Asset__c';

        if (!filters.isEmpty()) {
            queryString += ' WHERE ' + String.join(filters, ' AND ');
        }

        queryString += ' ORDER BY Name ASC';
        return Database.query(queryString);
    }

    private static Metadata_Asset__c findTargetAsset(String assetName, String departmentFilter) {
        if (!String.isBlank(assetName)) {
            List<Metadata_Asset__c> exactMatch = queryAssets(null, new Set<String>(), assetName, false);
            if (!exactMatch.isEmpty()) {
                return exactMatch[0];
            }
        }

        String normalizedDepartment = normalizeDepartment(departmentFilter);
        if (!String.isBlank(normalizedDepartment)) {
            List<Metadata_Asset__c> departmentAssets = queryAssets(normalizedDepartment, new Set<String>(), null, false);
            for (Metadata_Asset__c asset : departmentAssets) {
                if (asset.Owner_User__c == null) {
                    return asset;
                }
            }
            if (!departmentAssets.isEmpty()) {
                return departmentAssets[0];
            }
        }

        return null;
    }

    private static Decimal calculateAverageHealth(List<Metadata_Asset__c> assets) {
        if (assets.isEmpty()) {
            return 0;
        }

        Decimal totalScore = 0;
        for (Metadata_Asset__c asset : assets) {
            totalScore += asset.Health_Score__c == null ? deriveHealthScore(asset.Health_Status__c) : asset.Health_Score__c;
        }
        return (totalScore / assets.size()).setScale(2);
    }

    private static Decimal deriveHealthScore(String healthStatus) {
        if (healthStatus == 'Healthy') {
            return 95;
        }
        if (healthStatus == 'NeedsReview') {
            return 65;
        }
        if (healthStatus == 'Duplicate') {
            return 45;
        }
        return 25;
    }

    private static Integer countUnassigned(List<Metadata_Asset__c> assets) {
        Integer countValue = 0;
        for (Metadata_Asset__c asset : assets) {
            if (asset.Owner_User__c == null) {
                countValue++;
            }
        }
        return countValue;
    }

    private static Integer countStaleAssets(List<Metadata_Asset__c> assets, Integer staleThresholdDays) {
        Integer countValue = 0;
        for (Metadata_Asset__c asset : assets) {
            if (asset.Health_Status__c == 'Stale' || resolveStaleDays(asset) >= staleThresholdDays) {
                countValue++;
            }
        }
        return countValue;
    }

    private static Integer resolveStaleDays(Metadata_Asset__c asset) {
        if (asset.Stale_Days__c != null) {
            return Integer.valueOf(asset.Stale_Days__c);
        }
        if (asset.Last_Used_On__c != null) {
            return asset.Last_Used_On__c.daysBetween(Date.today());
        }
        return DEFAULT_STALE_THRESHOLD_DAYS;
    }

    private static Integer countDuplicateClusters(List<Metadata_Asset__c> assets) {
        Map<String, Integer> clusterCounts = new Map<String, Integer>();
        for (Metadata_Asset__c asset : assets) {
            if (String.isBlank(asset.Duplicate_Group_Key__c)) {
                continue;
            }
            Integer currentCount = clusterCounts.containsKey(asset.Duplicate_Group_Key__c)
                ? clusterCounts.get(asset.Duplicate_Group_Key__c)
                : 0;
            clusterCounts.put(asset.Duplicate_Group_Key__c, currentCount + 1);
        }

        Integer clusterCount = 0;
        for (String keyValue : clusterCounts.keySet()) {
            if (clusterCounts.get(keyValue) > 1) {
                clusterCount++;
            }
        }
        return clusterCount;
    }

    private static Decimal calculateOwnershipCoverage(List<Metadata_Asset__c> assets) {
        if (assets.isEmpty()) {
            return 0;
        }
        Decimal assignedAssets = assets.size() - countUnassigned(assets);
        return ((assignedAssets / assets.size()) * 100).setScale(2);
    }

    private static Decimal calculateClusterConfidence(List<Metadata_Asset__c> clusterAssets) {
        Set<String> assetTypes = new Set<String>();
        for (Metadata_Asset__c asset : clusterAssets) {
            assetTypes.add(asset.Asset_Type__c);
        }

        Decimal confidenceScore = assetTypes.size() == 1 ? 0.95 : 0.82;
        if (clusterAssets.size() >= 4) {
            confidenceScore += 0.03;
        }
        return confidenceScore > 0.99 ? 0.99 : confidenceScore;
    }

    private static List<Map<String, Object>> summarizeAssets(List<Metadata_Asset__c> assets, Integer maxItems) {
        List<Map<String, Object>> summaries = new List<Map<String, Object>>();
        Integer limitCount = Math.min(maxItems, assets.size());
        for (Integer indexValue = 0; indexValue < limitCount; indexValue++) {
            summaries.add(summarizeAsset(assets[indexValue], resolveStaleDays(assets[indexValue])));
        }
        return summaries;
    }

    private static Map<String, Object> summarizeAsset(Metadata_Asset__c asset, Integer staleDays) {
        return new Map<String, Object>{
            'id' => asset.Id,
            'name' => asset.Name,
            'apiName' => asset.API_Name__c,
            'type' => asset.Asset_Type__c,
            'department' => asset.Department__c,
            'ownerName' => asset.Owner_User__r != null ? asset.Owner_User__r.Name : null,
            'healthStatus' => asset.Health_Status__c,
            'healthScore' => asset.Health_Score__c,
            'riskLevel' => asset.Risk_Level__c,
            'duplicateGroupKey' => asset.Duplicate_Group_Key__c,
            'staleDays' => staleDays
        };
    }

    private static List<Map<String, Object>> buildDepartmentRollups(List<Metadata_Asset__c> assets) {
        Map<String, List<Metadata_Asset__c>> groupedAssets = new Map<String, List<Metadata_Asset__c>>();
        for (Metadata_Asset__c asset : assets) {
            String departmentKey = String.isBlank(asset.Department__c) ? 'Unspecified' : asset.Department__c;
            if (!groupedAssets.containsKey(departmentKey)) {
                groupedAssets.put(departmentKey, new List<Metadata_Asset__c>());
            }
            groupedAssets.get(departmentKey).add(asset);
        }

        List<Map<String, Object>> rollups = new List<Map<String, Object>>();
        for (String departmentKey : groupedAssets.keySet()) {
            List<Metadata_Asset__c> departmentAssets = groupedAssets.get(departmentKey);
            rollups.add(
                new Map<String, Object>{
                    'department' => departmentKey,
                    'totalAssets' => departmentAssets.size(),
                    'staleCount' => countStaleAssets(departmentAssets, DEFAULT_STALE_THRESHOLD_DAYS),
                    'unassignedCount' => countUnassigned(departmentAssets),
                    'healthScore' => calculateAverageHealth(departmentAssets)
                }
            );
        }
        return rollups;
    }

    private static String normalizeDepartment(String departmentFilter) {
        if (String.isBlank(departmentFilter)) {
            return null;
        }
        String trimmedDepartment = departmentFilter.trim();
        return trimmedDepartment.toLowerCase() == 'all' ? null : trimmedDepartment;
    }

    private static Set<String> parseStatusFilter(String statusFilter) {
        Set<String> statuses = new Set<String>();
        if (String.isBlank(statusFilter) || statusFilter.trim().toLowerCase() == 'all') {
            return statuses;
        }

        Map<String, String> statusMappings = new Map<String, String>{
            'healthy' => 'Healthy',
            'stale' => 'Stale',
            'duplicate' => 'Duplicate',
            'needsreview' => 'NeedsReview',
            'needs review' => 'NeedsReview'
        };

        for (String rawValue : statusFilter.split(',')) {
            String keyValue = rawValue.trim().toLowerCase();
            if (statusMappings.containsKey(keyValue)) {
                statuses.add(statusMappings.get(keyValue));
            }
        }
        return statuses;
    }

    private static Map<String, Object> parseJsonObject(String rawJson) {
        if (String.isBlank(rawJson)) {
            return new Map<String, Object>();
        }

        try {
            return (Map<String, Object>) JSON.deserializeUntyped(rawJson);
        } catch (Exception ignoredException) {
        }
        return new Map<String, Object>();
    }

    private static String recommendPrimaryAction(
        Integer staleCount,
        Integer unassignedCount,
        Integer duplicateClusterCount
    ) {
        if (staleCount >= unassignedCount && staleCount >= duplicateClusterCount) {
            return 'run a stale metadata review and re-attestation cycle for the highest-risk dormant assets.';
        }
        if (unassignedCount >= duplicateClusterCount) {
            return 'resolve unassigned ownership so stewardship decisions have accountable approvers.';
        }
        return 'review duplicate clusters and approve phased consolidation where dependency risk is low.';
    }

    private static String defaultString(String value, String fallbackValue) {
        return String.isBlank(value) ? fallbackValue : value;
    }

    private static String stringValue(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static Integer integerValue(Object value) {
        if (value == null) {
            return 0;
        }
        if (value instanceof Integer) {
            return (Integer) value;
        }
        if (value instanceof Long) {
            return Integer.valueOf(String.valueOf(value));
        }
        if (value instanceof Decimal) {
            return ((Decimal) value).intValue();
        }
        return Integer.valueOf(String.valueOf(value));
    }

    private static Decimal decimalValue(Object value) {
        if (value == null) {
            return 0;
        }
        if (value instanceof Decimal) {
            return (Decimal) value;
        }
        if (value instanceof Integer || value instanceof Long) {
            return Decimal.valueOf(String.valueOf(value));
        }
        return Decimal.valueOf(String.valueOf(value));
    }

    private static String formatInteger(Integer value) {
        return String.valueOf(value == null ? 0 : value);
    }

    private static String formatDecimal(Decimal value) {
        Decimal normalizedValue = value == null ? Decimal.valueOf('0') : value;
        return String.valueOf(normalizedValue.setScale(2));
    }
}
