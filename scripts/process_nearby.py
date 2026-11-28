import json
import os
import math
import urllib.request
from datetime import datetime
import osmium
from scipy.spatial import cKDTree

DATA_DIR = "data"
ILERLEME_FILE = os.path.join(DATA_DIR, "nearby_ilerleme.json")

TYPES_MAP = {
    'WATER': 'İçme Suyu', 'MARKET': 'Market', 'PHARMACY': 'Eczane',
    'CLINIC': 'Sağlık Ocağı/Klinik', 'HOSPITAL': 'Hastane', 'POLICE': 'Polis/Jandarma',
    'FUEL': 'Akaryakıt', 'ROAD': 'Anayol', 'CENTER': 'İlçe/Şehir Merkezi', 'TOILET': 'Tuvalet/Duş Tesisi'
}

RADII = {
    'WATER': 10, 'MARKET': 10, 'PHARMACY': 10, 'CLINIC': 10, 'FUEL': 10, 'TOILET': 10,
    'HOSPITAL': 30, 'POLICE': 30, 'CENTER': 30, 'ROAD': 15
}

GEOFABRIK_URLS = {
    'TR': 'https://download.geofabrik.de/europe/turkey-latest.osm.pbf'
}

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c

class POIHandler(osmium.SimpleHandler):
    def __init__(self):
        super(POIHandler, self).__init__()
        self.pois = []

    def process_element(self, tags, lat, lon):
        if not tags or lat is None or lon is None: return
        t = None
        if tags.get('amenity') == 'drinking_water' or tags.get('natural') == 'spring': t = 'WATER'
        elif tags.get('shop') in ['supermarket', 'convenience']: t = 'MARKET'
        elif tags.get('amenity') == 'pharmacy': t = 'PHARMACY'
        elif tags.get('amenity') in ['clinic', 'doctors']: t = 'CLINIC'
        elif tags.get('amenity') == 'hospital': t = 'HOSPITAL'
        elif tags.get('amenity') == 'police': t = 'POLICE'
        elif tags.get('amenity') == 'fuel': t = 'FUEL'
        elif tags.get('amenity') in ['toilets', 'shower']: t = 'TOILET'
        elif tags.get('highway') in ['trunk', 'primary']: t = 'ROAD'
        elif tags.get('place') in ['city', 'town']: t = 'CENTER'
        if not t: return

        name = tags.get('name', tags.get('name:tr', tags.get('name:en', '')))
        if not name or name.lower() in ['bed', 'drinking_water', 'market', 'toilet', 'spring', 'yes']:
            name = TYPES_MAP[t]

        self.pois.append({'type': t, 'name': name, 'lat': lat, 'lng': lon})

    def node(self, n):
        if 'amenity' in n.tags or 'natural' in n.tags or 'shop' in n.tags or 'place' in n.tags:
            self.process_element(n.tags, n.location.lat, n.location.lon)

def process_country(country_code, file_path):
    print(f"[{country_code}] İşleniyor...")
    with open(file_path, 'r', encoding='utf-8') as f:
        records = json.load(f)
        
    pbf_url = GEOFABRIK_URLS.get(country_code)
    if not pbf_url:
        print(f"[{country_code}] PBF linki yok, atlanıyor.")
        return None
        
    pbf_file = f"{country_code}.osm.pbf"
    if not os.path.exists(pbf_file):
        print(f"[{country_code}] PBF indiriliyor...")
        urllib.request.urlretrieve(pbf_url, pbf_file)
        
    print(f"[{country_code}] PBF ayrıştırılıyor...")
    handler = POIHandler()
    handler.apply_file(pbf_file)
    pois = handler.pois
    
    pois_by_type = {}
    for p in pois:
        if p['type'] not in pois_by_type:
            pois_by_type[p['type']] = {'coords': [], 'data': []}
        pois_by_type[p['type']]['coords'].append([p['lat'], p['lng']])
        pois_by_type[p['type']]['data'].append(p)
        
    trees = {}
    for t, v in pois_by_type.items():
        trees[t] = cKDTree(v['coords'])
        
    types_added = {}
    for r in records:
        if len(r.get('nearby', [])) > 0: continue
        r_lat, r_lon = r.get('latitude'), r.get('longitude')
        if r_lat is None or r_lon is None: continue
        
        best_pois = {}
        for p_type, tree in trees.items():
            deg_radius = RADII[p_type] / 111.0 
            dist, idx = tree.query([r_lat, r_lon], k=1, distance_upper_bound=deg_radius)
            if idx < len(pois_by_type[p_type]['data']):
                p = pois_by_type[p_type]['data'][idx]
                real_km = haversine(r_lat, r_lon, p['lat'], p['lng'])
                if real_km <= RADII[p_type]:
                    best_pois[p_type] = {
                        'type': p['type'], 'name': p['name'], 
                        'lat': round(p['lat'], 6), 'lng': round(p['lng'], 6), 'km': round(real_km, 2)
                    }
        nearby_list = list(best_pois.values())
        nearby_list.sort(key=lambda x: x['km'])
        r['nearby'] = nearby_list[:10]
        for p in r['nearby']:
            types_added[p['type']] = types_added.get(p['type'], 0) + 1
            
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
        
    empty_count = sum(1 for r in records if not r.get('nearby'))
    os.remove(pbf_file)
    return len(records), empty_count, types_added

def main():
    ilerleme = {}
    if os.path.exists(ILERLEME_FILE):
        with open(ILERLEME_FILE, 'r', encoding='utf-8') as f:
            ilerleme = json.load(f)
            
    file_path = os.path.join(DATA_DIR, "TR.json")
    if "TR" not in ilerleme:
        res = process_country("TR", file_path)
        if res:
            total, empty, types_added = res
            ilerleme["TR"] = {
                'total': total, 'empty': empty, 'filled': total - empty,
                'types_added': types_added, 'date': datetime.now().isoformat()
            }
            with open(ILERLEME_FILE, 'w', encoding='utf-8') as f:
                json.dump(ilerleme, f, ensure_ascii=False, indent=2)
            print("TR başarıyla işlendi.")
    else:
        print("TR zaten işlenmiş.")

if __name__ == "__main__":
    main()
